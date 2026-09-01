"use client";

import { Toaster as Sonner, ToasterProps } from "sonner";

// 토스트를 앱 카드와 같은 언어로 그린다.
//
// 예전 구현은 next-themes 의 useTheme() 로 테마를 읽었는데, 이 앱에는 ThemeProvider 가 없어서
// 항상 "system"(= OS 설정)이 나왔다. 앱을 다크로 바꿔도 OS 가 라이트면 토스트만 밝게 남는다.
// 다크 모드는 <html> 의 dark 클래스로만 관리되므로, 실제 앱 상태를 theme 로 넘겨받는다.
//
// 색은 전부 앱 토큰(var(--card) 등)으로 지정한다. 이 토큰들은 dark 클래스에 따라 이미 값이
// 바뀌므로 두 모드에서 따로 손댈 것이 없다. 폰트도 앱과 같은 것을 쓴다 — sonner 기본값은
// 자체 시스템 폰트 스택이라 한글이 다른 서체로 떠서 눈에 띄게 겉돌았다.
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
