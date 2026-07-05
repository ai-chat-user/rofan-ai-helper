// 페이지(MAIN world)에서 실행되는 API 감청 훅.
// 사이트가 스스로 불러오는 캐릭터 데이터(fetch/XHR)를 그대로 복사해
// CustomEvent로 content script에 전달한다. 요청을 바꾸거나 막지 않는다.
(() => {
  "use strict";

  if (window.__rofanHelperHooked) return;
  window.__rofanHelperHooked = true;

  const INTERESTING = /\/api\/|\/_next\/data\//i;
  const BUFFER_LIMIT = 80;
  const buffer = [];

  const notify = (url, body, reqBody) => {
    try {
      const detail = JSON.stringify({
        url: String(url),
        body: String(body).slice(0, 3000000),
        reqBody: reqBody ? String(reqBody).slice(0, 100000) : ""
      });
      buffer.push(detail);
      if (buffer.length > BUFFER_LIMIT) buffer.shift();
      window.dispatchEvent(new CustomEvent("rofan-helper:api", { detail }));
    } catch {
      // 전달 실패는 무시 — 사이트 동작에 영향을 주면 안 된다
    }
  };

  window.addEventListener("rofan-helper:flush-api-buffer", () => {
    buffer.forEach((detail) => {
      window.dispatchEvent(new CustomEvent("rofan-helper:api", { detail }));
    });
  });

  // 고정 인풋 주입 설정 (content script가 전달)
  let injectConfig = { enabled: false, markup: "" };
  window.addEventListener("rofan-helper:chat-inject", (event) => {
    try {
      const cfg = JSON.parse(String(event.detail || "{}"));
      injectConfig = { enabled: Boolean(cfg.enabled), markup: String(cfg.markup || "") };
    } catch {
      injectConfig = { enabled: false, markup: "" };
    }
  });

  // 단축어(치환) 설정 (content script가 전달)
  let shortcutsConfig = { enabled: false, list: [] };
  window.addEventListener("rofan-helper:shortcuts", (event) => {
    try {
      const cfg = JSON.parse(String(event.detail || "{}"));
      const list = Array.isArray(cfg.list) ? cfg.list
        .map((s) => ({ trigger: String(s.trigger || ""), content: String(s.content || "") }))
        .filter((s) => s.trigger && s.content) : [];
      shortcutsConfig = { enabled: Boolean(cfg.enabled), list };
    } catch {
      shortcutsConfig = { enabled: false, list: [] };
    }
  });

  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // 전송 직전 userChat 안의 `/명령어` 토큰을 등록된 내용으로 치환한다.
  function applyShortcuts(bodyStr) {
    if (!shortcutsConfig.enabled || !shortcutsConfig.list.length) return bodyStr;
    try {
      const data = JSON.parse(bodyStr);
      if (typeof data.userChat !== "string") return bodyStr;
      let text = data.userChat;
      // 긴 트리거부터 처리해 부분일치를 막는다(/노래방 이 /노래 로 먼저 잡히지 않게)
      const list = shortcutsConfig.list.slice().sort((a, b) => b.trigger.length - a.trigger.length);
      list.forEach(({ trigger, content }) => {
        const re = new RegExp("(^|\\s)\\/" + escapeRegex(trigger) + "(?=\\s|$)", "g");
        text = text.replace(re, (m, pre) => pre + content);
      });
      if (text === data.userChat) return bodyStr;
      data.userChat = text;
      return JSON.stringify(data);
    } catch {
      return bodyStr;
    }
  }

  // CreateMessage 전송 직전, userChat 뒤에 고정 인풋 마크업을 붙인다.
  // 실패 시 원본 그대로 둔다(전송을 절대 깨뜨리지 않음).
  function injectFixedInput(bodyStr) {
    if (!injectConfig.enabled || !injectConfig.markup) return bodyStr;
    try {
      const data = JSON.parse(bodyStr);
      if (typeof data.userChat !== "string") return bodyStr;
      if (data.userChat.includes(injectConfig.markup)) return bodyStr;
      data.userChat = data.userChat + injectConfig.markup;
      return JSON.stringify(data);
    } catch {
      return bodyStr;
    }
  }

  // 전송 직전 변환: 단축어 치환 → 고정 인풋 붙이기 순서.
  function transformOutgoing(bodyStr) {
    return injectFixedInput(applyShortcuts(bodyStr));
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      // CreateMessage 전송이면 단축어 치환 + 고정 인풋을 적용한다 (요청을 실제로 수정하는 유일한 지점)
      try {
        const rawUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (rawUrl && /\/api\/chat\/CreateMessage/i.test(rawUrl)
            && args[1] && typeof args[1].body === "string"
            && (injectConfig.enabled || shortcutsConfig.enabled)) {
          args[1] = Object.assign({}, args[1], { body: transformOutgoing(args[1].body) });
        }
      } catch {}
      const result = originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (url && INTERESTING.test(url)) {
          const reqBody = typeof args[1]?.body === "string" ? args[1].body : "";
          result.then((response) => {
            response.clone().text().then((text) => notify(url, text, reqBody)).catch(() => {});
          }).catch(() => {});
        }
      } catch {}
      return result;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__rofanHelperUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__rofanHelperUrl;
      if (url && INTERESTING.test(String(url))) {
        const reqBody = typeof args[0] === "string" ? args[0] : "";
        this.addEventListener("load", () => {
          try {
            notify(url, this.responseText, reqBody);
          } catch {}
        });
      }
    } catch {}
    return originalSend.apply(this, args);
  };
})();
