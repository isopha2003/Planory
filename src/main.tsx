  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import { installExternalLinkHandler } from "./lib/markdown";
  import "./styles/index.css";

  // 메모 본문의 링크가 앱 웹뷰를 떠나지 못하게 막고 OS 기본 브라우저로 넘긴다.
  // React 트리 바깥(document 캡처 단계)에 한 번만 걸어 두면 어느 화면의 <a> 든 동일하게 처리됨.
  installExternalLinkHandler();

  createRoot(document.getElementById("root")!).render(<App />);
