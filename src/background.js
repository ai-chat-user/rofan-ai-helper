// 외부 AI/NAI API 프록시 서비스워커.
// content script는 페이지 CORS에 묶여 외부 API를 직접 못 부르므로,
// 허용된 주소에 한해 여기서 대신 fetch 하고 결과를 돌려준다.
// (사용자 데이터를 임의 서버로 보내지 않음 — 사용자가 설정한 AI/NAI API 호출 전용)

const ALLOWED = [
  /^https:\/\/api\.novelai\.net\//,
  /^https:\/\/image\.novelai\.net\//,
  /^https:\/\/generativelanguage\.googleapis\.com\//,
  /^https:\/\/api\.deepseek\.com\//,
  /^https:\/\/api\.openai\.com\//,
  /^https:\/\/api\.x\.ai\//,
  /^https:\/\/api\.anthropic\.com\//,
  /^https:\/\/open\.er-api\.com\//
];

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  // NAI 생성 이미지를 다운로드 폴더(RofanHelper/NAI/)에 저장
  if (msg.type === "rh-download") {
    chrome.downloads.download(
      { url: msg.dataUrl, filename: `RofanHelper/NAI/${msg.filename || "image.png"}`, saveAs: false, conflictAction: "uniquify" },
      (id) => sendResponse({ ok: !chrome.runtime.lastError, id, error: chrome.runtime.lastError?.message })
    );
    return true;
  }
  // 다운로드 폴더 열기
  if (msg.type === "rh-show-folder") {
    try { chrome.downloads.showDefaultFolder(); sendResponse({ ok: true }); }
    catch (e) { sendResponse({ ok: false, error: String(e) }); }
    return;
  }
  if (msg.type !== "rh-fetch") return;
  (async () => {
    try {
      const url = String(msg.url || "");
      if (!ALLOWED.some((re) => re.test(url))) {
        sendResponse({ ok: false, status: 0, error: "허용되지 않은 주소입니다." });
        return;
      }
      const res = await fetch(url, {
        method: msg.method || "POST",
        headers: msg.headers || {},
        body: msg.body ?? undefined
      });
      if (msg.responseType === "arraybuffer") {
        const buf = await res.arrayBuffer();
        sendResponse({
          ok: res.ok,
          status: res.status,
          base64: bufToBase64(buf),
          contentType: res.headers.get("content-type") || ""
        });
      } else {
        sendResponse({ ok: res.ok, status: res.status, text: await res.text() });
      }
    } catch (error) {
      sendResponse({ ok: false, status: 0, error: String(error?.message || error) });
    }
  })();
  return true; // async sendResponse
});
