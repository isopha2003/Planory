// 메모에 붙는 이미지 저장·참조.
//
// 이미지는 DB가 아니라 앱 데이터 폴더의 파일로 둔다(%APPDATA%/<identifier>/note-images/).
// 본문에 base64 로 심으면 스크린샷 한 장에 수백 KB 의 문자열이 마크다운 원본 한가운데
// 박혀서, 사용자가 손으로 쓰는 마크다운을 읽을 수도 고칠 수도 없게 된다.
//
// 본문에는 실제 경로 대신 planory-img://<파일명> 이라는 참조만 적는다. 웹뷰가 로컬 파일을
// 읽으려면 asset 프로토콜 URL(플랫폼·설치 위치마다 다름)이 필요한데, 그걸 그대로 본문에
// 저장하면 다른 PC 로 DB 를 옮기거나 Tauri 가 URL 형식을 바꾸는 순간 전부 깨진다.
// 저장은 참조로, 화면에 그릴 때만 URL 로 바꾼다.

import { appDataDir, join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { mkdir, writeFile, exists, readDir, remove, stat } from "@tauri-apps/plugin-fs";

export const IMAGE_DIR_NAME = "note-images";
const SCHEME = "planory-img://";

// 허용 확장자 — 클립보드/파일에서 온 MIME 을 그대로 믿지 않고 이 표로만 매핑한다.
// 여기 없는 타입은 저장을 거부해서, 이미지인 척하는 임의 파일이 앱 데이터 폴더에
// 쌓이지 않게 한다.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

// appDataDir() 은 비동기인데 이미지 URL 은 렌더링 중(동기)에 필요하다 — 특히 tiptap 의
// renderHTML 은 동기 함수라 그 안에서 await 을 할 수 없다. 그래서 앱 시작 때 한 번 읽어
// 캐시해 두고, 이후 참조 → URL 변환은 전부 동기로 처리한다.
let imageDirPath: string | null = null;

export async function initNoteImages(): Promise<void> {
  const base = await appDataDir();
  const dir = await join(base, IMAGE_DIR_NAME);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  imageDirPath = dir;
}

export function isImageRef(src: string | undefined): src is string {
  return typeof src === "string" && src.startsWith(SCHEME);
}

// 본문에 저장된 참조 → 웹뷰가 읽을 수 있는 asset URL.
// 아직 초기화 전이거나 참조가 아니면 빈 문자열 — 호출 쪽에서 깨진 이미지 대신 아무것도
// 그리지 않도록 판단한다.
export function imageRefToUrl(ref: string): string {
  if (!isImageRef(ref) || !imageDirPath) return "";
  const name = ref.slice(SCHEME.length);
  // 참조는 우리가 만든 파일명만 담기지만, 손으로 고친 본문이 들어올 수 있으므로
  // 경로 구분자가 섞인 값은 폴더 밖을 가리킬 수 있어 거부한다.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return "";
  const sep = imageDirPath.includes("\\") ? "\\" : "/";
  return convertFileSrc(`${imageDirPath}${sep}${name}`);
}

// 클립보드/파일 선택/드롭에서 온 이미지 한 장을 저장하고 본문에 넣을 참조를 돌려준다.
// 지원하지 않는 타입이면 null.
export async function saveNoteImage(file: File | Blob): Promise<string | null> {
  const ext = EXT_BY_MIME[file.type];
  if (!ext) return null;
  if (!imageDirPath) await initNoteImages();
  if (!imageDirPath) return null;
  const name = `${crypto.randomUUID()}.${ext}`;
  const sep = imageDirPath.includes("\\") ? "\\" : "/";
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(`${imageDirPath}${sep}${name}`, bytes);
  return `${SCHEME}${name}`;
}

// DataTransfer(붙여넣기·드롭)에서 이미지 파일만 추려낸다.
// 이미지가 하나도 없으면 빈 배열 — 호출 쪽은 이때 기본 동작(텍스트 붙여넣기)을 그대로 둔다.
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter(f => !!EXT_BY_MIME[f.type]);
}

// 마크다운 본문에서 쓰는 이미지 문법.
export function imageMarkdown(ref: string, alt = "이미지"): string {
  return `![${alt}](${ref})`;
}

// ── 안 쓰는 이미지 정리 ────────────────────────────────────────────
// 메모에서 이미지를 지워도 파일은 폴더에 남는다. 스크린샷 한 장이 수백 KB 라 텍스트보다
// 훨씬 무겁고, 몇 년 쌓이면 이 폴더가 앱 데이터에서 제일 큰 덩어리가 된다.
//
// 방식은 "참조되지 않는 파일 지우기"(가비지 컬렉션). 메모를 지웠든, 본문에서 이미지만
// 뺐든, 폴더째 삭제했든 경로와 무관하게 같은 규칙 하나로 정리된다. 지우는 시점마다 일일이
// 훅을 거는 방식은 한 군데만 빠뜨려도 조용히 파일이 쌓인다.
//
// ⚠ 붙여넣은 직후의 파일은 절대 지우면 안 된다. 붙여넣기는 파일을 먼저 쓰고 본문에 참조를
// 넣는데, 그 메모는 "저장" 을 누르기 전까지 DB 에 없다. 이때 정리가 돌면 방금 붙여넣은
// 이미지가 사라진다. 그래서 만들어진 지 얼마 안 된 파일은 건드리지 않는다.
// 실행 취소(Ctrl+Z)로 되살리거나 메모 사이에서 잘라내 옮기는 경우도 이 유예가 지켜준다.
const GC_GRACE_MS = 24 * 60 * 60 * 1000;

// 본문에서 planory-img://<파일명> 참조들의 파일명만 뽑는다.
// 파일명 문자만 받아서, 뒤에 붙은 ")" 같은 마크다운 문법이 딸려 들어가지 않게 한다.
export function referencedImageNames(contents: string[]): Set<string> {
  const names = new Set<string>();
  const re = /planory-img:\/\/([A-Za-z0-9._-]+)/g;
  for (const c of contents) {
    for (const m of c.matchAll(re)) names.add(m[1]);
  }
  return names;
}

// 어떤 메모도 참조하지 않는 이미지 파일을 지운다.
// contents 는 호출 쪽에서 넘긴다 — 이 모듈이 DB 를 직접 알 필요가 없고, 테스트도 쉬워진다.
export async function cleanupUnusedImages(
  contents: string[],
  opts: { graceMs?: number } = {}
): Promise<{ removed: number; freedBytes: number; kept: number }> {
  const graceMs = opts.graceMs ?? GC_GRACE_MS;
  if (!imageDirPath) await initNoteImages();
  if (!imageDirPath) return { removed: 0, freedBytes: 0, kept: 0 };

  const used = referencedImageNames(contents);
  const sep = imageDirPath.includes("\\") ? "\\" : "/";
  const now = Date.now();
  let removed = 0, freedBytes = 0, kept = 0;

  for (const entry of await readDir(imageDirPath)) {
    if (!entry.isFile) continue;
    if (used.has(entry.name)) { kept++; continue; }
    const path = `${imageDirPath}${sep}${entry.name}`;
    try {
      const info = await stat(path);
      // 새로 만들어진 파일은 아직 저장되지 않은 메모의 것일 수 있으므로 유예.
      const madeAt = info.birthtime?.getTime() ?? info.mtime?.getTime() ?? 0;
      if (madeAt && now - madeAt < graceMs) { kept++; continue; }
      await remove(path);
      removed++;
      freedBytes += info.size ?? 0;
    } catch (e) {
      // 한 장 실패가 나머지 정리를 막지 않게 — 다음 실행에서 다시 시도된다.
      console.warn("이미지 정리 실패", entry.name, e);
    }
  }
  return { removed, freedBytes, kept };
}
