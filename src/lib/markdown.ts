// 메모 마크다운 렌더링에 공통으로 쓰는 remark 플러그인과 링크 열기 헬퍼.
//
// 미리보기·읽기 뷰는 react-markdown 을, 리치 에디터는 tiptap-markdown 을 쓴다. 두 경로가
// 같은 note.content 를 렌더하므로 줄바꿈 규칙이 어긋나면 "쓸 때랑 볼 때가 다른" 상태가 된다.
// 여기 있는 remarkBreaks 가 react-markdown 쪽을 tiptap 의 breaks:true 와 맞춰준다.

import { openUrl } from "@tauri-apps/plugin-opener";
import MarkdownIt from "markdown-it";
import markdownItCjkFriendly from "markdown-it-cjk-friendly";
import { notifyError } from "./notify";

// ── 엔터 한 번 = 줄바꿈 ────────────────────────────────────────────
// 표준 마크다운(CommonMark)은 줄 끝에 공백 두 칸이나 백슬래시가 있어야 줄바꿈으로 치고,
// 그냥 개행은 같은 문단의 이어지는 텍스트(= 렌더링 시 공백 한 칸)로 합쳐버린다.
// 메모장처럼 쓰는 앱에서 이건 "엔터를 쳤는데 줄이 안 바뀐다"로 보이므로, 문단 안의 개행을
// 전부 hard break 로 바꾼다. remark-breaks 와 같은 동작을 의존성 없이 직접 구현한 것.
//
// code/inlineCode 는 children 이 없는 리프 노드라 이 순회에 걸리지 않는다 —
// 코드 블록 안의 개행은 원문 그대로 보존됨.
export function remarkBreaks() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const next: any[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
          const parts = child.value.split(/\r?\n/);
          parts.forEach((part, i) => {
            if (i > 0) next.push({ type: "break" });
            if (part !== "") next.push({ type: "text", value: part });
          });
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    walk(tree);
  };
}

// ── 원본 줄 번호를 렌더 결과에 심기 ────────────────────────────────
// 마크다운 편집 화면에서 "지금 쓰고 있는 줄"에 해당하는 미리보기 위치로 스크롤하려면,
// 렌더된 DOM 요소가 자기가 원본 몇 번째 줄에서 나왔는지 알아야 한다. 블록 성격의 노드마다
// data-md-line 을 달아 두고, 편집기 쪽에서 커서 줄과 가장 가까운 요소를 찾아 스크롤한다.
//
// 최상위 노드만 달면 긴 목록 하나가 통째로 앵커 하나가 돼서 목록 안에서 움직일 때 따라오지
// 않는다. 그래서 목록 항목·인용문 내부까지 재귀적으로 단다.
export function remarkLineAnchors() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        const start = child.position?.start?.line;
        const end = child.position?.end?.line;
        // 인라인 노드(text/emphasis/…)는 자체 엘리먼트가 없거나 앵커로 쓰기엔 너무 잘다.
        if (start && BLOCK_TYPES.has(child.type)) {
          child.data = child.data ?? {};
          child.data.hProperties = {
            ...(child.data.hProperties ?? {}),
            "data-md-line": String(start),
            "data-md-end-line": String(end ?? start),
          };
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

const BLOCK_TYPES = new Set([
  "paragraph", "heading", "blockquote", "list", "listItem",
  "code", "table", "tableRow", "thematicBreak",
]);

// ── 커서 줄 → 미리보기 스크롤 위치 ────────────────────────────────
// 원본에서 커서가 있는 줄이 미리보기의 어느 픽셀 위치인지 구해, 그 지점이 화면 위에서 1/3
// 지점에 오도록 하는 scrollTop 을 돌려준다. 계산할 수 없으면 null.
//
// ⚠ 블록의 "시작 줄"만 가지고 앵커 사이를 보간하면 안 된다. 이 앱은 엔터 한 번을 줄바꿈으로
// 치기 때문에(remarkBreaks), 빈 줄 없이 쭉 써 내려간 긴 메모는 마크다운 상 문단 하나 =
// 앵커 하나다. 그러면 100줄을 써도 앵커가 두어 개뿐이라 커서가 어디 있든 미리보기가 늘 같은
// 자리(문서 끝)로 튀어서, 사실상 커서를 전혀 따라가지 않았다.
//
// 그래서 앵커마다 끝 줄(data-md-end-line)도 같이 심어두고, 커서를 품고 있는 블록을 찾아
// 그 블록의 높이를 자기 줄 수로 나눠 안에서 보간한다. 블록 하나가 100줄이어도 그 안에서
// 줄 단위로 따라간다.
export function previewScrollTopForLine(preview: HTMLElement, caretLine: number): number | null {
  const anchors = Array.from(preview.querySelectorAll<HTMLElement>("[data-md-line]"));
  if (anchors.length === 0) return null;

  // 글씨 크기 설정이 #root 에 CSS zoom 을 걸기 때문에, getBoundingClientRect() 가 돌려주는
  // 값(확대된 시각 px)과 scrollTop/scrollHeight(요소 안쪽 레이아웃 px)의 단위가 서로 다르다.
  // 둘을 그대로 섞으면 배율만큼 어긋나므로 rect 쪽을 배율로 나눠 레이아웃 px 로 환산한다.
  // offsetHeight 는 zoom 의 영향을 받지 않는 레이아웃 px 이라 배율을 역산하는 기준이 된다.
  const box = preview.getBoundingClientRect();
  const zoom = preview.offsetHeight > 0 ? box.height / preview.offsetHeight : 1;
  const scale = zoom > 0 ? zoom : 1;
  const topOf = (el: HTMLElement) => (el.getBoundingClientRect().top - box.top) / scale + preview.scrollTop;
  const heightOf = (el: HTMLElement) => el.getBoundingClientRect().height / scale;
  const lineOf = (el: HTMLElement) => Number(el.dataset.mdLine);
  const endLineOf = (el: HTMLElement) => Number(el.dataset.mdEndLine ?? el.dataset.mdLine);

  // 커서 줄을 품고 있는 앵커 중 가장 안쪽 것. DOM 순서상 바깥(ul) 이 먼저, 안쪽(li>p) 이
  // 나중에 나오므로 마지막으로 걸린 것이 가장 정확하다.
  let hit: HTMLElement | null = null;
  // 커서가 블록과 블록 사이 빈 줄에 있을 때를 위한 앞/뒤 블록.
  let prev: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const el of anchors) {
    if (lineOf(el) <= caretLine && caretLine <= endLineOf(el)) hit = el;
    else if (endLineOf(el) < caretLine) prev = el;
    else if (lineOf(el) > caretLine && !next) next = el;
  }

  let pos: number;
  if (hit) {
    // 블록 안 — 블록 높이를 그 블록이 차지한 줄 수로 나눠, 커서 줄의 윗변 위치를 잡는다.
    const first = lineOf(hit);
    const last = endLineOf(hit);
    const lines = Math.max(1, last - first + 1);
    pos = topOf(hit) + heightOf(hit) * ((caretLine - first) / lines);
  } else if (prev && next) {
    // 블록 사이 빈 줄 — 앞 블록의 끝과 뒤 블록의 시작 사이를 줄 수 비율로 나눈다.
    const from = topOf(prev) + heightOf(prev);
    const to = topOf(next);
    const span = Math.max(1, lineOf(next) - endLineOf(prev));
    pos = from + (to - from) * ((caretLine - endLineOf(prev)) / span);
  } else if (prev) {
    pos = topOf(prev) + heightOf(prev); // 문서 끝 뒤의 빈 줄
  } else {
    pos = 0; // 첫 블록보다 앞(문서 맨 앞 빈 줄 등)
  }

  const max = Math.max(0, preview.scrollHeight - preview.clientHeight);
  return Math.max(0, Math.min(max, pos - preview.clientHeight / 3));
}

// 문자열에서 커서 오프셋이 몇 번째 줄인지(1-base). remark 의 position 과 같은 기준.
export function lineAtOffset(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

// ── 링크를 OS 기본 브라우저로 ──────────────────────────────────────
// 앱 웹뷰에서 <a> 를 그냥 클릭하면 메모 화면이 그 사이트로 통째로 바뀌어 버리고, 앱에는
// 주소창도 뒤로가기도 없어서 빠져나올 방법이 없다(재시작해야 함). 그래서 기본 동작을 막고
// OS 기본 브라우저로 넘긴다.
//
// http/https/mailto 만 허용 — 메모 본문은 사용자가 붙여넣은 텍스트라, file: 이나 다른
// 스킴까지 OS 로 넘기면 의도치 않은 프로그램이 실행될 수 있다.
// (플러그인의 opener:default 권한도 http/https/mailto/tel 로 제한하므로 이중 방어.)
export function isExternalUrl(href: string | undefined): href is string {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href.trim());
}

export function openExternal(href: string | undefined) {
  if (!isExternalUrl(href)) return;
  openUrl(href.trim()).catch(notifyError("링크 열기 실패"));
}

// ── 앱 전체 링크 가로채기 ──────────────────────────────────────────
// 렌더러마다(react-markdown / tiptap / 앞으로 추가될 무엇이든) 각자 onClick 을 달아 두면,
// 한 군데라도 빠지는 순간 그 링크는 웹뷰를 통째로 외부 사이트로 끌고 가 앱이 돌아올 수 없는
// 상태가 된다. 그래서 개별 렌더러가 아니라 document 캡처 단계에서 한 번만 막는다.
// 캡처 단계라 React 의 onClick 보다 먼저 돌고, 어떤 경로로 만들어진 <a> 든 동일하게 걸린다.
//
// 편집 중(리치 텍스트 에디터 = contenteditable) 인 링크는 열지 않는다 — 링크 글자를 고치려고
// 클릭한 것이지 이동하려는 게 아니기 때문. 이 경우엔 기본 동작만 막고 커서 이동에 맡긴다.
//
// auxclick 도 함께 막는다: 가운데 버튼 클릭은 웹뷰에서 새 창을 열려는 시도가 되는데,
// 이 앱의 웹뷰에는 탭도 주소창도 없어서 그대로 두면 빈 창이 뜨거나 앱 화면이 대체된다.
export function installExternalLinkHandler() {
  const handle = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a");
    if (!a) return;
    // 앱 내부 동작용 앵커(href 없음 / "#")는 건드리지 않는다.
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    e.preventDefault();
    if (a.closest("[contenteditable='true'], [contenteditable='']")) return;
    openExternal(href);
  };
  document.addEventListener("click", handle, true);
  document.addEventListener("auxclick", handle, true);
}

// ── 한글 옆에서 강조(** **)가 풀리는 문제 ──────────────────────────
// CommonMark 는 닫는 ** 앞이 문장부호이면 그 뒤가 공백이나 문장부호일 때만 강조를 닫는다.
// 영어에는 맞는 규칙이지만 한글은 조사를 바로 붙여 쓰기 때문에 흔한 문장이 통째로 깨진다:
//
//   **텍스트(부가설명)**다른 문장   ← 닫는 ** 앞이 ")" 이고 뒤가 한글 → 강조 안 됨
//   **시간복잡도 O(N)**이다        ← 같은 이유
//   **dp[i][w]**는                ← 앞이 "]"
//
// 그동안은 ** 뒤에 한 칸을 띄워야만 했다. CommonMark 의 CJK 확장은 한글·한자·가나를
// 문장부호처럼 취급해 이 경우에도 강조가 닫히게 한다("2 ** 3" 같은 건 그대로 둔다).
//
// 미리보기·읽기 화면(remark)은 remark-cjk-friendly 플러그인으로 해결되지만, 리치 에디터는
// markdown-it 을 쓰는데 여기가 까다롭다:
//  - markdown-it-cjk-friendly 는 md.inline.State 를 인스턴스별로 갈아끼운다.
//  - 그런데 tiptap-markdown 은 저장할 때, 자기 모듈 안에 감춰둔 별도의 markdown-it
//    인스턴스로 "이 자리에서 ** 가 닫힐 수 있나"(scanDelims.can_close)를 검사하고,
//    닫을 수 없다고 판단하면 ** 를 왼쪽으로 밀어버린다. 그 인스턴스에는 손이 닿지 않는다.
//  - 파싱만 CJK 규칙을 쓰고 저장 검사는 표준 규칙을 쓰면 결과가 어긋나서,
//    "**시간복잡도 O(N)**이다" 가 "**시간복잡도 O(N**)이다" 로 저장돼 원문이 망가진다.
//
// 그래서 인스턴스가 아니라 ParserInline 의 프로토타입에 CJK 규칙 State 를 올린다.
// 이러면 앱 안의 모든 markdown-it 인스턴스(감춰진 것 포함)가 같은 규칙을 쓰므로 파싱과
// 저장이 어긋날 수 없다. 실패하면 조용히 예전 동작(강조 안 됨)으로 남는다 — 그때도 파싱과
// 저장이 함께 표준 규칙을 쓰므로 원문이 망가지지는 않는다.
export function installCjkFriendlyEmphasis(): void {
  try {
    const probe = new MarkdownIt() as any;
    markdownItCjkFriendly(probe);
    const patchedState = probe.inline?.State;
    const parserInlineProto = probe.inline ? Object.getPrototypeOf(probe.inline) : null;
    if (typeof patchedState !== "function" || !parserInlineProto) return;
    parserInlineProto.State = patchedState;
  } catch (e) {
    console.error("한글 강조 규칙 적용 실패", e);
  }
}
