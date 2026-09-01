  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import { installExternalLinkHandler, installCjkFriendlyEmphasis } from "./lib/markdown";
  import { initNoteImages } from "./lib/images";
  import "./styles/index.css";

  // 메모 본문의 링크가 앱 웹뷰를 떠나지 못하게 막고 OS 기본 브라우저로 넘긴다.
  // React 트리 바깥(document 캡처 단계)에 한 번만 걸어 두면 어느 화면의 <a> 든 동일하게 처리됨.
  installExternalLinkHandler();

  // 한글 바로 앞뒤에서 ** ** 강조가 풀리던 문제 — 마크다운 파서(markdown-it)의 규칙을
  // 손보는 것이라 에디터가 만들어지기 전에 한 번 실행해야 한다.
  installCjkFriendlyEmphasis();

  // 이미지 폴더 경로를 미리 읽어 둔다 — 렌더링 중(동기)에 참조 → URL 변환이 필요해서,
  // 첫 렌더 전에 끝나 있어야 저장된 이미지가 빈칸으로 잠깐 스쳤다 나타나는 일이 없다.
  // 실패해도(권한 문제 등) 앱 자체는 떠야 하므로 결과와 무관하게 렌더링을 진행한다.
  initNoteImages()
    .catch(e => console.error("이미지 폴더 준비 실패", e))
    .finally(() => {
      createRoot(document.getElementById("root")!).render(<App />);
    });
