// 메모 마크다운 렌더링에 공통으로 쓰는 remark 플러그인과 링크 열기 헬퍼.
//
// 미리보기·읽기 뷰는 react-markdown 을, 리치 에디터는 tiptap-markdown 을 쓴다. 두 경로가
// 같은 note.content 를 렌더하므로 줄바꿈 규칙이 어긋나면 "쓸 때랑 볼 때가 다른" 상태가 된다.
// 여기 있는 remarkBreaks 가 react-markdown 쪽을 tiptap 의 breaks:true 와 맞춰준다.

import { openUrl } from "@tauri-apps/plugin-opener";
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
        const line = child.position?.start?.line;
        // 인라인 노드(text/emphasis/…)는 자체 엘리먼트가 없거나 앵커로 쓰기엔 너무 잘다.
        if (line && BLOCK_TYPES.has(child.type)) {
          child.data = child.data ?? {};
          child.data.hProperties = { ...(child.data.hProperties ?? {}), "data-md-line": String(line) };
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

// ── 링크를 OS 기본 브라우저로 ──────────────────────────────────────
// 앱 웹뷰에서 <a> 를 그냥 클릭하면 메모 화면이 그 사이트로 통째로 바뀌어 버리고, 앱에는
// 주소창도 뒤로가기도 없어서 빠져나올 방법이 없다(재시작해야 함). 그래서 기본 동작을 막고
// OS 기본 브라우저로 넘긴다.
//
// http/https/mailto 만 허용 — 메모 본문은 사용자가 붙여넣은 텍스트라, file: 이나 다른
// 스킴까지 OS 로 넘기면 의도치 않은 프로그램이 실행될 수 있다.
// (src-tauri/capabilities/default.json 의 opener 스코프와 같은 기준.)
export function isExternalUrl(href: string | undefined): href is string {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href.trim());
}

export function openExternal(href: string | undefined) {
  if (!isExternalUrl(href)) return;
  openUrl(href.trim()).catch(notifyError("링크 열기 실패"));
}
