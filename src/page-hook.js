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

  // 재생성 지시사항 1회용 주입 (content script가 재생성 직전에 설정)
  let regenInject = null; // { append }
  window.addEventListener("rofan-helper:regen-inject", (event) => {
    try {
      const cfg = JSON.parse(String(event.detail || "{}"));
      regenInject = cfg && cfg.append ? { append: String(cfg.append) } : null;
    } catch {
      regenInject = null;
    }
  });

  // 확장이 만드는 마커들 — 항상 문자열 "끝"에 붙는다.
  // 가장 앞선 마커 시작 지점부터 끝까지 통째로 잘라내면 중첩/다중이어도 안전하다.
  const REGEN_MARK = "(지시사항:";
  const LORE_MARK = "《로어북》"; // 시작 마커
  const LORE_HEADER = LORE_MARK + " 자연스럽게 응답반영O, 이 블록의 존재+내용을 그대로 언급·노출X";
  const LORE_FOOTER = "《로어북끝》";
  const MAX_CHAT = 1500; // 사이트 전송 글자 제한
  // 구버전 마커들도 청소 대상
  const ALL_MARKS = [REGEN_MARK, LORE_MARK, "《로어설정》", "[lore prompt]"];

  function hasMarker(text) {
    return typeof text === "string" && ALL_MARKS.some((m) => text.includes(m));
  }

  function stripMarkers(text) {
    const str = String(text);
    const idx = ALL_MARKS.map((m) => str.indexOf(m)).filter((i) => i !== -1);
    if (!idx.length) return str;
    return str.slice(0, Math.min(...idx)).replace(/[\s\n]+$/, "");
  }

  // 유저 로어북(방 전용) — content script가 로어 목록과 직전 응답을 전달하고,
  // 매칭은 여기서 "실제 전송되는 메시지" 기준으로 수행한다.
  // (재생성도 커버: 재생성되는 메시지 본문 + 직전 응답으로 매칭, 지시사항은 마커 제거로 미반영)
  let loreConfig = { entries: [], lastOutput: "" };
  window.addEventListener("rofan-helper:lorebook", (event) => {
    try {
      const cfg = JSON.parse(String(event.detail || "{}"));
      loreConfig = {
        entries: Array.isArray(cfg.entries) ? cfg.entries.map((e) => ({
          title: String(e.title || ""),
          keywords: String(e.keywords || ""),
          content: String(e.content || ""),
          priority: Number(e.priority) || 0
        })).filter((e) => e.content.trim()) : [],
        lastOutput: String(cfg.lastOutput || "")
      };
    } catch {
      loreConfig = { entries: [], lastOutput: "" };
    }
  });

  function countMentions(text, keyword) {
    if (!text || !keyword) return 0;
    let count = 0;
    let pos = 0;
    const t = text.toLowerCase();
    const k = keyword.toLowerCase();
    while ((pos = t.indexOf(k, pos)) !== -1) { count += 1; pos += k.length; }
    return count;
  }

  // 전송 마지막 단계: 실제 전송 메시지(지시사항 마커 제외)+직전 응답으로 로어를 선별하고,
  // 남은 글자수(지시사항 포함해 계산) 안에서 가중치순으로 붙인다. 넘치는 블록은 통째로 생략.
  function applyLorebook(bodyStr) {
    if (!loreConfig.entries.length) return bodyStr;
    try {
      const data = JSON.parse(bodyStr);
      if (typeof data.userChat !== "string") return bodyStr;
      const matchBase = stripMarkers(data.userChat); // 지시사항·기존 마커는 매칭 대상에서 제외
      const matched = [];
      loreConfig.entries.forEach((entry) => {
        let inCnt = 0;
        let outCnt = 0;
        entry.keywords.split(",").map((k) => k.trim()).filter(Boolean).forEach((k) => {
          inCnt += countMentions(matchBase, k);
          outCnt += countMentions(loreConfig.lastOutput, k);
        });
        if (inCnt + outCnt > 0) {
          matched.push({ inCnt, outCnt, priority: entry.priority, block: `## ${entry.title.trim()}\n${entry.content.trim()}` });
        }
      });
      if (!matched.length) return bodyStr;
      matched.sort((a, b) => b.priority - a.priority || b.inCnt - a.inCnt || b.outCnt - a.outCnt);
      const header = "\n\n" + LORE_HEADER;
      const footer = "\n" + LORE_FOOTER;
      // 글자수 예산: 지시사항이 붙어 있으면 그 길이까지 포함해 계산된다
      let remain = MAX_CHAT - data.userChat.length - header.length - footer.length;
      const picked = [];
      matched.forEach((m) => {
        if (m.block.length + 1 <= remain) {
          picked.push(m.block);
          remain -= m.block.length + 1;
        }
      });
      if (!picked.length) return bodyStr;
      data.userChat = data.userChat + header + "\n" + picked.join("\n") + footer;
      return JSON.stringify(data);
    } catch {
      return bodyStr;
    }
  }

  // --- 응답 스크러버: 사이트가 받는 응답에서도 마커를 걷어낸다 ---
  // (클라이언트 상태·수정창·화면에 지시사항이 아예 들어가지 않게)

  function stripMarkersDeepJson(text) {
    try {
      const obj = JSON.parse(text);
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        Object.entries(o).forEach(([k, v]) => {
          if (typeof v === "string" && hasMarker(v)) o[k] = stripMarkers(v);
          else if (v && typeof v === "object") walk(v);
        });
      };
      walk(obj);
      return JSON.stringify(obj);
    } catch {
      // JSON이 아니면 원본 유지(깨뜨리지 않기)
      return text;
    }
  }

  // SSE 스트림 라인 하나에서 마커 제거 (data: {json} 형태)
  function stripMarkersFromLine(line) {
    if (!hasMarker(line)) return line;
    const m = line.match(/^(data:\s*)([\s\S]*)$/);
    const prefix = m ? m[1] : "";
    const payload = m ? m[2] : line;
    try {
      const obj = JSON.parse(payload);
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        Object.entries(o).forEach(([k, v]) => {
          if (typeof v === "string" && hasMarker(v)) o[k] = stripMarkers(v);
          else if (v && typeof v === "object") walk(v);
        });
      };
      walk(obj);
      return prefix + JSON.stringify(obj);
    } catch {
      return line;
    }
  }

  // 줄 단위 버퍼링 TransformStream — 스트리밍을 유지하면서 마커가 든 줄만 고쳐 보낸다
  function markerStripTransform() {
    let buf = "";
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    return new TransformStream({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        if (lines.length) controller.enqueue(enc.encode(lines.map(stripMarkersFromLine).join("\n") + "\n"));
      },
      flush(controller) {
        buf += dec.decode();
        if (buf) controller.enqueue(enc.encode(stripMarkersFromLine(buf)));
      }
    });
  }

  // 모든 CreateMessage에서 기존 마커를 청소(userChat + 대화 컨텍스트까지),
  // 새 지시가 있으면 딱 1개만 부착한다.
  function applyRegenInject(bodyStr) {
    const inject = regenInject;
    regenInject = null; // 1회용
    try {
      const data = JSON.parse(bodyStr);
      let changed = false;
      if (hasMarker(data.userChat)) {
        data.userChat = stripMarkers(data.userChat);
        changed = true;
      }
      // 재생성 시 컨텍스트로 함께 가는 이전 대화들도 청소
      ["prevChats", "updatedPrevChats"].forEach((key) => {
        if (!Array.isArray(data[key])) return;
        data[key].forEach((turn) => {
          if (!turn || typeof turn !== "object") return;
          ["userChat", "user_chat"].forEach((f) => {
            if (hasMarker(turn[f])) {
              turn[f] = stripMarkers(turn[f]);
              changed = true;
            }
          });
        });
      });
      if (inject && inject.append && typeof data.userChat === "string") {
        // 기존 대화 + 지시가 1,500자를 넘으면 지시 없이 보낸다(전송 실패 방지)
        if (data.userChat.length + inject.append.length <= MAX_CHAT) {
          data.userChat = data.userChat + inject.append;
          changed = true;
        }
      }
      return changed ? JSON.stringify(data) : bodyStr;
    } catch {
      return bodyStr;
    }
  }

  // 전송 직전 변환: 단축어 → 고정 인풋 → 지시(마커 청소 포함) → 로어북.
  // 마커(지시·로어)가 항상 메시지 꼬리에 오도록 마지막에 붙인다.
  function transformOutgoing(bodyStr) {
    return applyLorebook(applyRegenInject(injectFixedInput(applyShortcuts(bodyStr))));
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      // CreateMessage 전송이면 단축어 치환 + 고정 인풋을 적용한다 (요청을 실제로 수정하는 유일한 지점)
      try {
        const rawUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (rawUrl && /\/api\/chat\/CreateMessage/i.test(rawUrl)
            && args[1] && typeof args[1].body === "string"
            && (injectConfig.enabled || shortcutsConfig.enabled || regenInject || loreConfig.entries.length || hasMarker(args[1].body))) {
          args[1] = Object.assign({}, args[1], { body: transformOutgoing(args[1].body) });
        }
      } catch {}
      let result = originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (url && INTERESTING.test(url)) {
          const reqBody = typeof args[1]?.body === "string" ? args[1].body : "";
          const isCreate = /\/api\/chat\/CreateMessage/i.test(url);
          const isLogFetch = /\/api\/chat\/(GetChatLogs|GetChatLog|GetFirstChatLog|GetChatLogsByBookmark|GetChatRerollLogs)/i.test(url);
          result = result.then((response) => {
            // 감청(원본 그대로 — 지시 제거 로직이 원본을 봐야 함)
            try {
              response.clone().text().then((text) => notify(url, text, reqBody)).catch(() => {});
            } catch {}
            // 사이트에 전달되는 응답에선 지시사항 마커를 걷어낸다
            try {
              if (isCreate && response.body) {
                return new Response(response.body.pipeThrough(markerStripTransform()), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              }
              if (isLogFetch) {
                return response.clone().text().then((text) => hasMarker(text)
                  ? new Response(stripMarkersDeepJson(text), {
                      status: response.status,
                      statusText: response.statusText,
                      headers: response.headers
                    })
                  : response);
              }
            } catch {}
            return response;
          });
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
