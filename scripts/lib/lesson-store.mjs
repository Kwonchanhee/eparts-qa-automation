// qa_lessons Firestore 컬렉션 유틸.
// - saveLesson: QA close/merge 시 자동 수집 (한 QA당 upsert)
// - findRelatedLessons: 새 이슈 생성 시 관련 과거 사례 조회 (source/category/tags 기반)
//
// Claude가 이 lesson들을 자동으로 컨텍스트에 반영하도록 poll-and-dispatch가 이슈 body에 주입.

import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

// 도메인 키워드 사전. 여기 등록된 단어가 제목/설명에 등장하면 태그로 추출.
// 새 키워드 발견 시 여기에 추가 (수동 큐레이션). 정교한 NLP는 v2에서.
const KEYWORD_DICT = [
  // 인증/계정
  'SMS', '문자', '인증번호', '비밀번호', '아이디', '로그인', '회원가입', '가입', '토큰', 'JWT',
  // 결제/주문
  '결제', '주문', '송장', '송장번호', '배송', '이니시스', '무통장', '카드', '환불', '취소',
  // 상품/재고
  '상품', '부품', '재고', '입고', '출고', '바코드', '이미지', '썸네일', '가격', '판매', '손망실',
  // UI/레이아웃
  '반응형', '레이아웃', '모바일', '태블릿', '데스크탑', '드랍다운', '드롭다운', '모달', '팝업', '헤더', '네비게이션',
  // 카테고리성
  '차량', '차종', '연식', '제조사', '검색', '필터', '카테고리',
  // 페이지
  '마이페이지', '장바구니', '메인', '홈', '상세', '목록', '관리자', '셀러', '유저',
  // 기술 힌트
  'CORS', 'API', 'DB', '데이터베이스', '캐시', 'N+1', '성능', '속도',
];

/**
 * 제목+설명에서 도메인 키워드 추출.
 * 중복 제거, 소문자화, 최대 20개.
 */
export function extractTags(text) {
  if (!text) return [];
  const lowered = String(text).toLowerCase();
  const hits = new Set();
  for (const kw of KEYWORD_DICT) {
    if (lowered.includes(kw.toLowerCase())) hits.add(kw);
  }
  return Array.from(hits).slice(0, 20);
}

/**
 * 매칭용 keywords(소문자 concat text). 태그로 못 잡은 단어도 word-intersection에 쓰기 위함.
 */
export function makeKeywordsText(title, description) {
  return `${title ?? ''} ${description ?? ''}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 4000);
}

/**
 * 하나의 QA(1 리포트)에 대한 lesson 저장. upsert (같은 sourceQaId면 덮어씀).
 * @param {import('firebase-admin/firestore').Firestore} db
 * @param {object} lesson
 */
export async function saveLesson(db, lesson) {
  const {
    sourceQaId,
    source,
    category,
    title,
    description,
    issueUrl,
    prUrls,
    rerequestCount,
    outcome, // 'merged' | 'closed_no_pr' | 'wont_fix' | 'rolled_back'
    summary, // 짧은 lesson (수동/자동 생성; 초기엔 description 앞부분으로 fallback)
    rerequestMessages, // 관리자가 남긴 재요청 메시지들 (실수 패턴 학습에 유용)
    finalClaudeComment, // Claude의 마지막 응답 요약
  } = lesson;

  if (!sourceQaId) throw new Error('sourceQaId required');

  const docRef = db.collection('qa_lessons').doc(sourceQaId);
  const tags = extractTags(`${title} ${description ?? ''}`);
  const keywords = makeKeywordsText(title, description);

  const now = Timestamp.now();
  await docRef.set(
    {
      sourceQaId,
      source: source ?? 'user',
      category: category ?? 'other',
      title: title ?? '(제목 없음)',
      description: description ?? '',
      issueUrl: issueUrl ?? null,
      prUrls: prUrls ?? [],
      rerequestCount: rerequestCount ?? 0,
      outcome: outcome ?? 'merged',
      summary: summary ?? '',
      rerequestMessages: rerequestMessages ?? [],
      finalClaudeComment: finalClaudeComment ?? '',
      tags,
      keywords,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      _createdAtTs: now, // Firestore Timestamp 정렬용 (serverTimestamp는 정렬 순간 값이라 정렬용 별도 필드)
    },
    { merge: true },
  );
  return docRef.id;
}

/**
 * 새 이슈에 대해 관련 과거 lesson 조회.
 * 랭킹:
 *   1) same source (+5)
 *   2) same category (+3)
 *   3) tag intersection count (+1 each)
 *   4) rerequestCount > 0 (+2, 실패/재요청 많은 것 우선)
 *   5) outcome='wont_fix' or 'rolled_back' (+3, 함정 사례)
 *   6) 최근 90일 (+1)
 *
 * @returns {Promise<Array<object>>} 상위 N개 lesson (기본 5)
 */
export async function findRelatedLessons(db, criteria, limit = 5) {
  const { source, category, title, description } = criteria;
  const newTags = extractTags(`${title ?? ''} ${description ?? ''}`);

  // Firestore는 복합 인덱스 없이 다중 필드 정렬이 제약이 있어 클라이언트 랭킹.
  // 소량 (수백 개 예상) 이므로 status=active 전체 pull → 메모리 랭킹.
  const snap = await db
    .collection('qa_lessons')
    .where('status', '==', 'active')
    .get();

  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const scored = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    let score = 0;
    if (source && d.source === source) score += 5;
    if (category && d.category === category) score += 3;
    if (Array.isArray(d.tags) && newTags.length > 0) {
      const inter = d.tags.filter((t) => newTags.includes(t)).length;
      score += inter;
    }
    if ((d.rerequestCount ?? 0) > 0) score += 2;
    if (d.outcome === 'wont_fix' || d.outcome === 'rolled_back') score += 3;
    const created = d._createdAtTs?.toMillis?.() ?? d.createdAt?.toMillis?.() ?? 0;
    if (created && now - created < NINETY_DAYS_MS) score += 1;

    if (score > 0) scored.push({ score, doc: { id: doc.id, ...d } });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.doc);
}

/**
 * lesson 배열을 GitHub 이슈 body 섹션(markdown)으로 변환.
 * Claude가 이슈 처리 시 이 섹션을 자연스러운 컨텍스트로 인식하도록 프롬프트 형태.
 */
export function renderLessonsForIssue(lessons) {
  if (!lessons || lessons.length === 0) return '';
  const lines = [
    '',
    '---',
    '',
    '## 🧠 관련 과거 교훈 (자동 수집) — 반드시 참고하세요',
    '',
    '이 이슈와 유사한 과거 처리 사례입니다. **아래 사례들을 반드시 검토하고, 특히 재요청 사유와 이전 Claude의 판단 실수를 다시 반복하지 마세요.**',
    '`closed_no_pr`/`wont_fix`는 이전에 "코드 변경 없음"이나 잘못된 저장소 판단으로 실패했던 케이스이니, 이번엔 실제로 수정 가능한 지점을 재확인하세요.',
    '',
  ];

  lessons.forEach((l, i) => {
    const outcomeIcon = {
      merged: '✅',
      closed_no_pr: '⚠️',
      wont_fix: '❌',
      rolled_back: '↩️',
    }[l.outcome] ?? '📝';
    const outcomeLabel = {
      merged: '처리완료',
      closed_no_pr: '코드변경 없이 종료(주의)',
      wont_fix: '보류',
      rolled_back: '롤백',
    }[l.outcome] ?? l.outcome;

    lines.push(`### ${i + 1}. ${outcomeIcon} [${l.source}/${l.category}] ${l.title}`);
    lines.push(`- **결과**: ${outcomeLabel}${l.rerequestCount > 0 ? ` · 재요청 ${l.rerequestCount}회 발생 (관리자가 여러 번 수정 요청)` : ''}`);
    if (l.issueUrl) lines.push(`- 원본 이슈: ${l.issueUrl}`);
    if (Array.isArray(l.prUrls) && l.prUrls.length > 0) {
      lines.push(`- 관련 PR: ${l.prUrls.slice(0, 5).join(', ')}`);
    }

    // 원본 요청 요약 (관리자가 애초에 뭘 원했는지)
    const desc = l.summary || l.description || '';
    if (desc) {
      const short = String(desc).replace(/\s+/g, ' ').trim().slice(0, 300);
      lines.push(`- **원본 요청 요약**: ${short}${short.length >= 300 ? '…' : ''}`);
    }

    // 재요청 사유 (관리자가 왜 다시 요청했는지 = 이전 처리의 실수 지점)
    if (Array.isArray(l.rerequestMessages) && l.rerequestMessages.length > 0) {
      lines.push(`- **관리자 재요청 사유(이전 처리 실수 지점)**:`);
      l.rerequestMessages.slice(0, 3).forEach((m) => {
        const short = String(m).replace(/\s+/g, ' ').slice(0, 250);
        lines.push(`  - "${short}"`);
      });
    }

    // Claude의 마지막 응답 요약 (자동 처리 불가 판단 사유 등)
    if (l.finalClaudeComment) {
      const short = String(l.finalClaudeComment).replace(/\s+/g, ' ').trim().slice(0, 400);
      lines.push(`- **이전 Claude 마지막 응답 요약**: ${short}${short.length >= 400 ? '…' : ''}`);
    }

    // 롤백된 케이스는 특별히 강조 (같은 방향으로 재수정하면 또 롤백당함)
    if (l.outcome === 'rolled_back') {
      lines.push('- ⚠️ **이 방향의 수정은 이후 관리자가 롤백했음**. 같은 방식으로 재수정 시 또 롤백될 가능성 큼.');
    }

    lines.push('');
  });

  lines.push('**주의**: 위 사례들의 결과/재요청 사유를 반영하지 않고 이전과 똑같이 처리하면 관리자가 다시 재요청하거나 롤백할 가능성이 높습니다. 코드 변경이 필요없다고 판단되면, "왜 관리자가 이슈를 등록했을지" 재확인하세요 (dev/prod 배포 격차, 캐시, 재현 시나리오 등).');
  lines.push('', '---', '');
  return lines.join('\n');
}
