(() => {
  "use strict";

  if (!location.hostname.endsWith("rofan.ai")) return;
  if (window.__rofanHelperLoaded) return;
  window.__rofanHelperLoaded = true;

  const STORE_KEY = "rofanHelperState";
  const VERSION = 1;
  const HELPER_VERSION = typeof chrome !== "undefined" && chrome.runtime?.getManifest
    ? chrome.runtime.getManifest().version
    : "dev";
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const CHAT_SCAN_SELECTORS = [
    "[data-testid*='message' i]",
    "[class*='message' i]",
    "[class*='chat' i] article",
    "article",
    "main p",
    "main [class*='bubble' i]"
  ];

  const defaultState = () => ({
    version: VERSION,
    settings: {
      theme: "none",
      fontFamily: "",
      customCSS: "",
      viewMode: "card",
      cardInfoExpanded: true,
      pinnedMenu: true,
      hiddenTags: [],
      excludedGenders: [],
      chatAutosave: false,
      autosaveMinutes: 3,
      folderColors: {},
      userScripts: [],
      launcherPos: null,
      chatCardFolderColor: { background: false, border: false },
      chatInput: { fixedEnabled: false, fixedText: "" },
      // /단축어 치환: enabled + [{trigger, content}] 목록. showChips = 입력창에 [/명령어] 칩 표시.
      shortcuts: { enabled: false, showChips: true, list: [] },
      // NAI 이미지 생성 연동
      nai: {
        enabled: false,
        imgProvider: "nai", // nai | gpt | gemini | grok
        aiProvider: "gemini", // gemini | deepseek | openai | grok | claude
        aiCfg: {}, // 제공사별 { key, model } 저장
        aiKey: "",   // (구버전 호환)
        aiModel: "", // (구버전 호환)
        naiKey: "",
        templates: [null, null, null, null], // 그림체 1~4
        activeTemplate: 0,
        // 서비스별 이미지 생성 설정 (gpt/gemini/grok)
        imgCfg: {
          gpt: { model: "", size: "1024x1536", prompt: "" },
          gemini: { model: "", prompt: "" },
          grok: { model: "", prompt: "" }
        },
        // 서비스별 AI 지시문 (비우면 기본값)
        instructions: { nai: "", gpt: "", gemini: "", grok: "" },
        template: null, // 템플릿 이미지 메타데이터에서 추출한 생성 파라미터 {prompt, negative, model, sampler, steps, scale, width, height, seed, raw}
        seedLocked: false,
        promptInstruction: ""
      },
      // 최초 설치 시 대화목록/팔로우/제작자 캐릭터를 1회 불러와야 개인 기능이 열린다.
      onboarding: { chatListDone: false, followsDone: false, creatorCharsDone: false },
      chatListCollection: {
        active: false,
        page: 1,
        rooms: 0,
        characters: 0,
        startedAt: "",
        lastCollectedAt: "",
        visited: []
      }
    },
    characters: {},
    creators: {},
    rooms: {},
    recentCharacterIds: [],
    playLog: [],
    backups: {},
    importantMessages: {},
    naiHistory: []
  });

  let state = defaultState();
  let panel;
  let panelBody;
  let launcher;
  let route = location.href;
  let observer;
  let autosaveTimer;
  let renderQueued = false;
  let starMode = false;
  let selectedCharacterId = "";
  let selectedCreatorId = "";
  let dataSection = "";
  let creatorMenu;
  let roomEditor;
  let roomDialog;
  let stickerEdit = null;
  let activeRoomMenuId = "";
  let chatListCollectTimer;
  let chatListCollectRunning = false;
  let pageBotsById = new Map();
  const supplementalBotsById = new Map();
  const revealedCreatorCharacters = new Set();
  let hookApplyTimer;
  let hookSaveTimer;
  let recentBotsLastAttempt = 0;
  let recentBotsFetching = false;
  let lastEnhancedIds = new Set();
  const creatorLookupQueued = new Set();
  const creatorLookupDone = new Set();
  const creatorLookupInFlight = new Set();
  const creatorLookupRetryAt = new Map(); // id -> 다음 재시도 허용 시각(ms)
  let navigationPauseUntil = 0;
  let creatorLookupRunning = false;

  const storage = {
    async get() {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const result = await chrome.storage.local.get(STORE_KEY);
        return result[STORE_KEY];
      }
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    },
    async set(value) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ [STORE_KEY]: value });
        return;
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(value));
    }
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[ch]);
  const today = () => new Date().toISOString().slice(0, 10);
  const nowIso = () => new Date().toISOString();
  const compact = (value, max = 180) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const normalizeList = (value) => String(value ?? "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = (items) => Array.from(new Set(items.filter(Boolean)));
  const debounce = (fn, wait = 250) => {
    let id;
    return (...args) => {
      clearTimeout(id);
      id = setTimeout(() => fn(...args), wait);
    };
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function saveState() {
    await storage.set(state);
  }

  function scheduleHookStateSave() {
    clearTimeout(hookSaveTimer);
    hookSaveTimer = setTimeout(() => {
      saveState().catch(() => {});
    }, 1000);
  }

  function scheduleHookApply() {
    clearTimeout(hookApplyTimer);
    hookApplyTimer = setTimeout(() => {
      if (shouldDeferAutoEnhance()) return;
      applyEnhancements({ preserveEditors: true });
    }, 120);
  }

  function mergeState(saved) {
    const base = defaultState();
    const merged = {
      ...base,
      ...(saved || {}),
      settings: {
        ...base.settings,
        ...(saved?.settings || {}),
        chatListCollection: {
          ...base.settings.chatListCollection,
          ...(saved?.settings?.chatListCollection || {})
        },
        nai: {
          ...base.settings.nai,
          ...(saved?.settings?.nai || {})
        }
      },
      naiHistory: saved?.naiHistory || [],
      characters: saved?.characters || {},
      creators: saved?.creators || {},
      rooms: saved?.rooms || {},
      recentCharacterIds: saved?.recentCharacterIds || [],
      playLog: saved?.playLog || [],
      backups: saved?.backups || {},
      importantMessages: saved?.importantMessages || {}
    };
    Object.values(merged.characters || {}).forEach((character) => {
      delete character.snapshot;
      delete character.changedFields;
    });
    return merged;
  }

  function parseNextData() {
    const script = $("#__NEXT_DATA__");
    if (!script?.textContent) return null;
    try {
      return JSON.parse(script.textContent);
    } catch {
      return null;
    }
  }

  function walkBots(value, out = []) {
    if (!value) return out;
    if (Array.isArray(value)) {
      value.forEach((item) => walkBots(item, out));
      return out;
    }
    if (typeof value !== "object") return out;
    const normalized = normalizeBotCandidate(value);
    if (normalized) out.push(normalized);
    Object.values(value).forEach((item) => {
      if (item && typeof item === "object") walkBots(item, out);
    });
    return out;
  }

  function normalizeBotCandidate(value) {
    if (!value || typeof value !== "object") return null;
    // 대화 예시(GetDialogueExamples 등)는 bot_id+char를 갖지만 char가 캐릭터명이 아니라
    // 예시 대화문이다. 캐릭터로 오인해 이름을 덮어쓰지 않도록 거부한다.
    if (value.example_id || value.exampleId || value.dialogue_id || value.dialogueId) return null;
    if (("user" in value) && ("char" in value) && !value.char_image && !value.charImage && !Array.isArray(value.tags)) return null;
    // 대화방(GetDetailChatList/GetChatList) 항목은 bot_id+char+char_image를 갖지만
    // chat_count가 "그 방의 메시지 수"라서 캐릭터로 오인하면 캐릭터 통계(사람수/평균/제작자)를
    // 방 값으로 덮어쓴다 — chat_id/room_id 등 대화방 신호가 있으면 봇으로 취급하지 않는다.
    if (value.chat_id || value.chatId || value.room_id || value.roomId || value.conversation_id
        || value.conversationId || value.chat_title || value.bot_chat || value.last_chat || value.lastChat) return null;
    const id = firstText(
      value.bot_id,
      value.botId,
      value.botID,
      value.character_id,
      value.characterId,
      value.characterID,
      value.char_id,
      value.charId,
      value.id,
      value.uuid
    );
    if (!id || !UUID_RE.test(id)) return null;

    const name = firstText(
      value.char,
      value.character_name,
      value.characterName,
      value.char_name,
      value.charName,
      value.bot_name,
      value.botName,
      value.name,
      value.title
    );
    const image = firstText(
      value.char_image,
      value.charImage,
      value.character_image,
      value.characterImage,
      value.thumbnail_image,
      value.thumbnailImage,
      value.bot_image,
      value.botImage,
      value.profile_image,
      value.profileImage,
      value.image,
      value.thumbnail,
      value.thumbnail_url,
      value.thumbnailUrl
    );
    const hasBotSignal = Boolean(
      value.bot_id ||
      value.botId ||
      value.character_id ||
      value.characterId ||
      value.char_id ||
      value.charId ||
      value.char ||
      value.char_image ||
      value.charImage ||
      value.character_name ||
      value.characterName ||
      value.char_name ||
      value.charName ||
      value.bot_name ||
      value.botName
    );
    // 캐릭터임을 확신할 수 있는 신호: 이미지/태그/대화수/유저수/요약/제작자 중 하나
    const hasStrongBotSignal = Boolean(
      image ||
      Array.isArray(value.tags) ||
      value.char_image || value.charImage ||
      value.chat_count != null || value.chatCount != null ||
      value.user_count != null || value.userCount != null ||
      value.summary || value.creator
    );
    if (!hasBotSignal || !hasStrongBotSignal) return null;

    return {
      ...value,
      bot_id: id,
      // 이름이 없으면 UUID 조각으로 채우지 않는다 — 빈 값이면 표시 단계에서 "로딩중"
      char: name || "",
      char_image: image || value.char_image || "",
      chat_count: value.chat_count ?? value.chatCount ?? value.chats ?? value.chat ?? value.message_count ?? value.messageCount ?? value.talk_count ?? value.talkCount,
      user_count: value.user_count ?? value.userCount ?? value.users ?? value.play_user_count ?? value.playUserCount ?? value.player_count ?? value.playerCount,
      created: firstText(
        value.created,
        value.created_at,
      value.createdAt,
      value.create_at,
      value.createAt,
      value.create_date,
      value.createDate,
      value.created_date,
      value.createdDate,
      value.created_at_str,
      value.createdAtStr,
      value.createdAtString,
      value.created_date_str,
      value.createdDateStr,
      value.createdDateString,
      value.reg_date,
      value.regDate,
      value.register_date,
      value.registerDate,
      value.registered_at,
      value.registeredAt,
      value.regist_date,
      value.registDate,
      value.published_at,
      value.publishedAt,
      value.publish_date,
      value.publishDate,
      value.opened_at,
      value.openedAt,
      value.released_at,
      value.releasedAt,
      value.release_date,
      value.releaseDate,
      value.inserted_at,
      value.insertedAt,
      value.created_time,
      value.createdTime,
      value.create_time,
      value.createTime
      ) || value.created,
      updated: firstText(
        value.updated,
        value.updated_at,
        value.updatedAt,
        value.modified,
        value.modified_at,
        value.modifiedAt,
        value.updated_date,
        value.updatedDate
      ) || value.updated
    };
  }

  function readPageBots() {
    const data = parseNextData();
    const pageProps = data?.props?.pageProps || {};
    const bots = uniqueBy(walkBots(pageProps || data), (bot) => bot.bot_id);
    pageBotsById = new Map(bots.map((bot) => [bot.bot_id, bot]));
    return bots;
  }

  function botById(id) {
    return pageBotsById.get(id) || supplementalBotsById.get(id) || null;
  }

  function setupPageHookBridge() {
    window.addEventListener("rofan-helper:api", handlePageHookApi);
    window.dispatchEvent(new CustomEvent("rofan-helper:flush-api-buffer"));
  }

  function handlePageHookApi(event) {
    const detail = parseHookApiDetail(event.detail);
    if (!detail) return;
    const url = String(detail.url || "");
    // Next.js 클라이언트 페이지 전환(/_next/data/) 감지 → React가 이전 페이지를
    // 언마운트하는 동안 카드 장식을 멈춰 removeChild 충돌(Application error)을 막는다
    if (/\/_next\/data\//i.test(url)) {
      navigationPauseUntil = Date.now() + 1200;
    }
    // 사용자가 채팅 메시지를 전송하면(CreateMessage) 그 캐릭터를 "플레이"로 기록한다.
    // (요청 payload의 chatData.bot_id 사용 — 사이트가 제공한 정보로만 처리)
    if (/\/api\/chat\/CreateMessage/i.test(url)) {
      markPlayedFromSend(detail.reqBody);
    }
    // 캐릭터 정보를 열면 사이트가 GetBotTags/GetSeparatedBotAssets(botId 포함)를 부른다 →
    // 대화목록 모달 등 어디서 봤든 "최근 본 캐릭터"에 기록한다.
    if (/\/api\/bot\/(GetBotTags|GetSeparatedBotAssets)/i.test(url)) {
      markViewedFromApi(detail.reqBody);
    }
    const data = parseJsonText(detail.body);
    if (!data) return;
    if (ingestHookApiData(data)) scheduleHookApply();
  }

  function markPlayedFromSend(reqBody) {
    const payload = parseJsonText(reqBody);
    const chatData = payload?.chatData || payload?.chat_data || payload || {};
    const botId = firstText(chatData.bot_id, chatData.botId, payload?.bot_id, payload?.botId);
    if (!botId || !UUID_RE.test(botId)) return;
    // 이름/이미지는 rofan이 준 정보로 채운다: 우선 페이지에 로드된 봇 데이터, 없으면 payload
    const bot = botById(botId);
    if (bot) {
      ensureCharacter(botId, botToCharacterPatch(bot));
    } else {
      const name = firstText(chatData.char, chatData.character_name, chatData.characterName);
      const image = firstText(chatData.char_image, chatData.characterImage, chatData.character_image);
      const patch = {};
      if (name && !UUID_RE.test(name)) patch.name = name;
      if (image) patch.image = image;
      if (Object.keys(patch).length) ensureCharacter(botId, patch);
    }
    markPlayed(botId);
    scheduleHookStateSave();
    scheduleHookApply();
  }

  function markViewedFromApi(reqBody) {
    const payload = parseJsonText(reqBody);
    const botId = firstText(payload?.botId, payload?.bot_id, payload?.id);
    if (!botId || !UUID_RE.test(botId)) return;
    const bot = botById(botId);
    markViewed(botId, bot ? botToCharacterPatch(bot) : {});
    scheduleHookStateSave();
    scheduleHookApply();
  }

  function parseHookApiDetail(detail) {
    if (!detail) return null;
    if (typeof detail === "object") return detail;
    try {
      return JSON.parse(String(detail));
    } catch {
      return null;
    }
  }

  function parseJsonText(text) {
    const raw = String(text ?? "").trim();
    if (!raw || !/^[\[{]/.test(raw)) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function ingestHookApiData(data) {
    const bots = uniqueBy(walkBots(data), (bot) => bot.bot_id);
    const rooms = uniqueBy(walkRooms(data), (room) => room.id);
    const creatorInfos = uniqueBy(walkCreatorInfos(data), (c) => c.id);
    let shouldSave = false;
    let shouldRender = false;

    // GetCreatorInfo 응답 등에서 제작자 닉네임 + 프로필 이미지를 흡수 (신뢰: profile 출처)
    creatorInfos.forEach((info) => {
      const patch = {};
      const name = sanitizeCreatorName(info.nickname || info.name || info.displayName || "");
      if (name) { patch.name = name; patch.nameSource = "profile"; }
      if (info.profile) patch.image = String(info.profile);
      if (!Object.keys(patch).length) return;
      const prev = state.creators[info.id] || {};
      if (patch.name !== prev.name || patch.image !== prev.image) {
        ensureCreator(info.id, patch);
        shouldSave = true;
        shouldRender = true;
      }
    });
    bots.forEach((bot) => {
      if (!bot?.bot_id || !bot?.char) return;
      const before = supplementalBotsById.get(bot.bot_id);
      supplementalBotsById.set(bot.bot_id, bot);
      shouldRender = true;

      if (updateStoredCharacterIfNeeded(bot)) shouldSave = true;

      const patch = botToCharacterPatch(bot);
      if (patch.creatorId) {
        const creatorPatch = creatorPatchFromBot(bot);
        const prevName = creatorDisplayName(state.creators[patch.creatorId]);
        if (creatorPatch.name && creatorPatch.name !== prevName) {
          ensureCreator(patch.creatorId, creatorPatch);
          shouldSave = true;
        }
      }

      if (!before || before.chat_count !== bot.chat_count || before.user_count !== bot.user_count) {
        shouldRender = true;
      }
    });

    rooms.forEach((room) => {
      if (!room.id) return;
      const before = state.rooms[room.id] || {};
      ensureRoom(room.id, room);
      if (room.characterId) {
        const prevChar = state.characters[room.characterId] || {};
        ensureCharacter(room.characterId, {
          name: room.characterName || prevChar.name || "",
          image: room.characterImage || prevChar.image || "",
          played: true,
          lastPlayedAt: nowIso()
        });
      }
      if (roomChanged(before, state.rooms[room.id])) shouldSave = true;
      shouldRender = true;
    });

    if (shouldSave) scheduleHookStateSave();
    return shouldRender;
  }

  function walkRooms(value, out = []) {
    if (!value) return out;
    if (Array.isArray(value)) {
      value.forEach((item) => walkRooms(item, out));
      return out;
    }
    if (typeof value !== "object") return out;
    const room = roomPatchFromApiObject(value);
    if (room?.id) out.push(room);
    Object.values(value).forEach((item) => {
      if (item && typeof item === "object") walkRooms(item, out);
    });
    return out;
  }

  // GetCreatorInfo 응답 형태({ id, nickname, profile, introduce })를 재귀로 찾는다
  function walkCreatorInfos(value, out = []) {
    if (!value) return out;
    if (Array.isArray(value)) {
      value.forEach((item) => walkCreatorInfos(item, out));
      return out;
    }
    if (typeof value !== "object") return out;
    const id = firstText(value.id, value.user_id, value.userId, value.creator_id, value.creatorId);
    const hasNick = value.nickname || value.displayName;
    // 캐릭터(bot)와 구분: 제작자 정보는 nickname/profile/introduce를 갖고 bot_id/char는 없다
    if (id && UUID_RE.test(id) && (hasNick || value.profile !== undefined || value.introduce !== undefined)
        && !value.bot_id && !value.char && !value.char_image) {
      out.push({ id, nickname: value.nickname, name: value.name, displayName: value.displayName, profile: value.profile });
    }
    Object.values(value).forEach((item) => {
      if (item && typeof item === "object") walkCreatorInfos(item, out);
    });
    return out;
  }

  function roomPatchFromApiObject(item) {
    const id = firstText(
      item.chat_id,
      item.chatId,
      item.room_id,
      item.roomId,
      item.conversation_id,
      item.conversationId,
      item.thread_id,
      item.threadId,
      item.url?.match?.(UUID_RE)?.[0],
      item.link?.match?.(UUID_RE)?.[0],
      hasRoomSignal(item) ? item.id : ""
    );
    if (!id || !UUID_RE.test(id)) return null;

    const bot = objectValue(item.bot, item.character, item.char_info, item.charInfo);
    const persona = objectValue(item.persona, item.my_persona, item.myPersona, item.userPersona);
    const folder = objectValue(item.folder, item.category);
    const characterId = firstText(
      item.bot_id,
      item.botId,
      item.character_id,
      item.characterId,
      bot?.bot_id,
      bot?.id,
      bot?.character_id
    );
    const characterName = firstText(
      item.character_name,
      item.characterName,
      item.bot_name,
      item.botName,
      item.char,
      bot?.char,
      bot?.name,
      bot?.title
    );
    const personaName = firstText(
      item.persona_name,
      item.personaName,
      item.my_persona_name,
      item.myPersonaName,
      persona?.name,
      persona?.nickname,
      persona?.title
    );
    const folderName = firstText(
      item.folder_name,
      item.folderName,
      item.category_name,
      item.categoryName,
      folder?.name,
      folder?.title
    );
    const folderColor = firstText(
      item.folder_color,
      item.folderColor,
      folder?.folder_color,
      folder?.color
    );
    const title = firstText(
      item.chat_title,
      item.chatTitle,
      item.room_title,
      item.roomTitle,
      item.title,
      item.name
    );
    return {
      id,
      url: `/chat/${id}`,
      title,
      characterId,
      characterName,
      characterImage: firstText(item.character_image, item.characterImage, item.char_image, item.charImage, bot?.char_image, bot?.image),
      personaName,
      personaImage: firstText(item.persona_image, item.personaImage, persona?.image, persona?.avatar),
      folderName,
      folderColor,
      source: "api",
      lastCollectedAt: nowIso()
    };
  }

  function roomChanged(before = {}, after = {}) {
    const keys = [
      "title",
      "url",
      "characterId",
      "characterName",
      "characterImage",
      "personaName",
      "personaImage",
      "folderName",
      "folderColor",
      "note",
      "characterAvatar",
      "personaAvatar"
    ];
    return keys.some((key) => String(before[key] ?? "") !== String(after[key] ?? ""));
  }

  function hasRoomSignal(item) {
    const keys = Object.keys(item || {}).join(" ");
    if (/(chat|room|conversation|thread)/i.test(keys)) return true;
    if (/(persona|folder)/i.test(keys) && /(bot|character|char)/i.test(keys)) return true;
    if (/\/chat\/[0-9a-f-]{36}/i.test(String(item?.url || item?.link || ""))) return true;
    return false;
  }

  function firstText(...values) {
    return values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  }

  function objectValue(...values) {
    return values.find((value) => value && typeof value === "object") || null;
  }

  // "새로 나온 캐릭터" 카드는 서버 렌더링 데이터에 없고 이 API로 클라이언트에서 로드된다.
  async function ensureRecentBotsData() {
    if (recentBotsFetching) return;
    if (Date.now() - recentBotsLastAttempt < 20 * 1000) return;
    recentBotsFetching = true;
    recentBotsLastAttempt = Date.now();
    try {
      const section = findNewSectionContainers()[0];
      const gender = (section && $("select", section)?.value) || "all";
      const response = await fetch("/api/bot/GetRecentBotList", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: 1, pageSize: 12, gender })
      });
      if (!response.ok) return;
      const data = await response.json();
      let added = false;
      (data?.botList || []).forEach((bot) => {
        if (!bot?.bot_id || !bot?.char) return;
        supplementalBotsById.set(bot.bot_id, bot);
        added = true;
      });
      if (added) applyEnhancements({ preserveEditors: true });
    } catch {
      // 네트워크 실패 시 20초 뒤 재시도
    } finally {
      recentBotsFetching = false;
    }
  }

  function uniqueBy(items, keyFn) {
    const map = new Map();
    items.forEach((item) => {
      const key = keyFn(item);
      if (key && !map.has(key)) map.set(key, item);
    });
    return Array.from(map.values());
  }

  function toNumber(value) {
    if (typeof value === "number") return value;
    const raw = String(value ?? "").trim();
    if (!raw) return 0;
    if (raw.includes("천")) return Math.round(parseFloat(raw) * 1000);
    if (raw.includes("만")) return Math.round(parseFloat(raw) * 10000);
    return Number(raw.replace(/[^\d.]/g, "")) || 0;
  }

  function formatCount(value) {
    const num = Number(value) || 0;
    if (num >= 10000) return `${(num / 10000).toFixed(num % 10000 ? 1 : 0)}만`;
    if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 ? 1 : 0)}천`;
    return String(num);
  }

  function ensureCharacter(id, patch = {}) {
    if (!id) return null;
    const prev = state.characters[id] || {};
    const next = {
      id,
      firstSeenAt: prev.firstSeenAt || nowIso(),
      ...prev,
      ...patch,
      updatedAt: nowIso()
    };
    state.characters[id] = next;
    return next;
  }

  function ensureCreator(id, patch = {}) {
    if (!id) return null;
    const prev = state.creators[id] || {};
    const cleanPatch = { ...patch };
    if ("name" in cleanPatch) {
      cleanPatch.name = sanitizeCreatorName(cleanPatch.name);
      if (!cleanPatch.name) {
        delete cleanPatch.name;
        delete cleanPatch.nameSource;
      }
    }
    const next = {
      id,
      firstSeenAt: prev.firstSeenAt || nowIso(),
      ...prev,
      ...cleanPatch,
      updatedAt: nowIso()
    };
    state.creators[id] = next;
    return next;
  }

  function botToCharacterPatch(bot) {
    const chatCount = toNumber(bot.chat_count);
    const userCount = toNumber(bot.user_count);
    const creatorId = creatorIdFromBot(bot);
    const createdAt = firstText(
      bot.created,
      bot.created_at,
      bot.createdAt,
      bot.create_at,
      bot.createAt,
      bot.create_date,
      bot.createDate,
      bot.created_date,
      bot.createdDate,
      bot.created_at_str,
      bot.createdAtStr,
      bot.createdAtString,
      bot.created_date_str,
      bot.createdDateStr,
      bot.createdDateString,
      bot.reg_date,
      bot.regDate,
      bot.register_date,
      bot.registerDate,
      bot.registered_at,
      bot.registeredAt,
      bot.regist_date,
      bot.registDate,
      bot.published_at,
      bot.publishedAt,
      bot.publish_date,
      bot.publishDate,
      bot.opened_at,
      bot.openedAt,
      bot.released_at,
      bot.releasedAt,
      bot.release_date,
      bot.releaseDate,
      bot.inserted_at,
      bot.insertedAt,
      bot.created_time,
      bot.createdTime,
      bot.create_time,
      bot.createTime
    );
    const modifiedAt = firstText(
      bot.updated,
      bot.updated_at,
      bot.updatedAt,
      bot.modified,
      bot.modified_at,
      bot.modifiedAt,
      bot.updated_date,
      bot.updatedDate
    );
    const hasUser = bot.user_count != null || bot.userCount != null;
    const hasChat = bot.chat_count != null || bot.chatCount != null;
    const patch = {
      image: bot.char_image,
      summary: bot.summary,
      tags: bot.tags || [],
      createdAt,
      modifiedAt
    };
    // 값이 실제로 있을 때만 채운다 — 없는데 0으로 덮어써 기존 통계를 지우지 않도록.
    if (creatorId) patch.creatorId = creatorId;
    if (hasChat) patch.chatCount = chatCount;
    if (hasUser) patch.userCount = userCount;
    if (hasUser && hasChat) patch.averageChats = userCount ? Number((chatCount / userCount).toFixed(1)) : 0;
    // 정상 캐릭터명(비어있지 않고 UUID가 아닐 때)만 채운다 — 빈 값/찌꺼기로 덮어쓰지 않음
    const cleanName = String(bot.char || "").trim();
    if (cleanName && !UUID_RE.test(cleanName)) patch.name = cleanName;
    return patch;
  }

  function creatorIdFromBot(bot) {
    const value = bot?.creator;
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      return value.id || value.user_id || value.userId || value.uuid || value.creator_id || "";
    }
    return bot?.creator_id || bot?.creatorId || "";
  }

  function creatorPatchFromBot(bot) {
    // API bot 필드의 이름 후보(bot.nickname 등)는 캐릭터명/엉뚱한 값이 섞여
    // 잘못된 제작자 이름이 저장·고착되는 원인이었다 — 더 이상 이름을 수확하지 않는다.
    // 이름은 오직 /user/{id} 프로필 조회(runCreatorLookupQueue)로만 얻는다.
    return {};
  }

  function creatorNameFromBot(bot) {
    const creator = bot?.creator && typeof bot.creator === "object" ? bot.creator : {};
    const info = bot?.creator_info || bot?.creatorInfo || bot?.author || bot?.user || {};
    const candidates = [
      bot?.creator_name,
      bot?.creatorName,
      bot?.creator_nickname,
      bot?.creatorNickname,
      bot?.author_name,
      bot?.authorName,
      bot?.nickname,
      creator.nickname,
      creator.nickName,
      creator.name,
      creator.display_name,
      creator.displayName,
      info.nickname,
      info.nickName,
      info.name,
      info.display_name,
      info.displayName
    ];
    const creatorId = creatorIdFromBot(bot);
    return candidates
      .map((value) => String(value || "").trim())
      .map(sanitizeCreatorName)
      .find((value) => value && value !== creatorId) || "";
  }

  async function ingestPageData() {
    const bots = readPageBots();
    let changed = false;
    const profileCreatorId = currentProfileCreatorId();
    if (profileCreatorId) {
      const profile = creatorProfileFromNextData(parseNextData());
      if (Object.keys(profile).length) {
        ensureCreator(profileCreatorId, profile);
        changed = true;
      }
    }
    bots.forEach((bot) => {
      if (updateStoredCharacterIfNeeded(bot)) changed = true;
    });

    const currentId = currentCharacterId();
    if (currentId && isCharacterDetailPage()) {
      const bot = bots.find((item) => item.bot_id === currentId);
      markViewed(currentId, bot ? botToCharacterPatch(bot) : {});
      changed = true;
    }

    if (looksLikeChatPage() && currentId) {
      markPlayed(currentId);
      changed = true;
    }

    if (changed) await saveState();
  }

  function updateStoredCharacterIfNeeded(bot) {
    const prev = state.characters[bot.bot_id];
    if (!prev) return false;
    const patch = botToCharacterPatch(bot);
    ensureCharacter(bot.bot_id, patch);
    if (patch.creatorId) ensureCreator(patch.creatorId, creatorPatchFromBot(bot));
    return true;
  }

  function mergedCharacterInfo(id, anchor) {
    const bot = botById(id);
    const live = bot ? botToCharacterPatch(bot) : {};
    const stored = state.characters[id] || {};
    return {
      id,
      ...live,
      ...stored,
      name: stored.name || live.name || inferCharacterNameFromAnchor(anchor) || "",
      createdAt: stored.createdAt || live.createdAt || "",
      modifiedAt: stored.modifiedAt || live.modifiedAt || ""
    };
  }

  function inferCharacterNameFromAnchor(anchor) {
    const lines = String(anchor?.innerText || "")
      .split(/\n+/)
      .map((line) => compact(line, 60))
      .filter(Boolean)
      .filter((line) => !/^\d+(\.\d+)?(천|만)?$/.test(line))
      .filter((line) => !line.startsWith("#"))
      .filter((line) => !/^(NEW|PLAYING|메모\/평점|숨김|링크|로딩중\.{0,3})$/i.test(line));
    const first = lines[0] || "";
    if (/^[\d.]+(천|만)?\s+/.test(first)) return "";
    return first.length <= 30 ? first : "";
  }

  function currentCharacterId() {
    const match = location.pathname.match(/\/character\/([0-9a-f-]{36})/i);
    if (match) return match[1];
    if (looksLikeChatPage()) {
      const linkMatch = $("a[href*='/character/']")?.href?.match(UUID_RE);
      if (linkMatch) return linkMatch[0];
    }
    const bots = readPageBots();
    if (bots.length === 1) return bots[0].bot_id;
    const hrefMatch = location.href.match(UUID_RE);
    return hrefMatch && state.characters[hrefMatch[0]] ? hrefMatch[0] : null;
  }

  function currentProfileCreatorId() {
    const match = location.pathname.match(/\/user\/([0-9a-f-]{36})/i);
    return match ? match[1] : "";
  }

  function creatorProfileFromNextData(data) {
    const pageProps = data?.props?.pageProps || {};
    const creator = pageProps.creator || {};
    const profile = {};
    const name = sanitizeCreatorName(creator.nickname || creator.name || creator.displayName || "");
    if (name) {
      profile.name = name;
      profile.nameSource = "profile";
    }
    const image = firstText(creator.profile, creator.profileImage, creator.profile_image, creator.image, creator.avatar);
    if (image) profile.image = image;
    // 팔로우 상태(following/notify)는 SSR initialIsFollowing으로 절대 설정하지 않는다 —
    // 정적/ISR 캐시본이 로그인 전 값(false)을 담고 있어 실제로는 팔로우 중인데 해제로
    // 덮어써지는 문제가 있었다(제작자 페이지 방문 시 팔로우가 사라짐).
    // 팔로우 상태는 (1) 최초 팔로우 불러오기, (2) 제작자 메뉴 열 때 실시간 GetFollows,
    // (3) 사용자가 직접 토글할 때만 갱신한다. (followsCount는 공개 지표라 유지)
    if ("initialFollowsCount" in pageProps) profile.followsCount = toNumber(pageProps.initialFollowsCount);
    return profile;
  }

  function isCharacterDetailPage() {
    return /\/character\/[0-9a-f-]{36}/i.test(location.pathname);
  }

  function currentRoomId() {
    const id = location.href.match(UUID_RE)?.[0];
    return looksLikeChatPage() ? (id || `page:${location.pathname}`) : `page:${location.pathname}`;
  }

  function looksLikeChatPage() {
    return /\/(chat|room|conversation|talk|messages?)(\/|\?|$)/i.test(location.pathname + location.search);
  }

  function markViewed(id, patch = {}) {
    const char = ensureCharacter(id, { ...patch, lastViewedAt: nowIso(), seen: true });
    state.recentCharacterIds = unique([id, ...state.recentCharacterIds]).slice(0, 50);
    if (char?.creatorId) ensureCreator(char.creatorId, { lastSeenAt: nowIso() });
  }

  function markPlayed(id) {
    const roomId = currentRoomId();
    const recentDuplicate = state.playLog.some((item) => {
      if (item.characterId !== id || item.roomId !== roomId) return false;
      return Date.now() - new Date(item.at).getTime() < 60 * 60 * 1000;
    });
    if (recentDuplicate) {
      ensureCharacter(id, { played: true, lastPlayedAt: nowIso() });
      return;
    }
    const char = ensureCharacter(id, { played: true, lastPlayedAt: nowIso() });
    state.playLog.unshift({
      date: today(),
      at: nowIso(),
      characterId: id,
      creatorId: char?.creatorId || "",
      roomId
    });
    state.playLog = state.playLog.slice(0, 5000);
  }

  function shortId(id) {
    return String(id || "").slice(0, 8);
  }

  function creatorDisplayName(creator) {
    const name = sanitizeCreatorName(creator?.name || "");
    if (!name) return "";
    // 신뢰 체계: 제작자 프로필 페이지에서 확인했거나(profile) 사용자가 직접 입력한(manual)
    // 이름만 표시한다. 모달 텍스트/API 필드에서 주워 담은 미검증 값은 표시하지 않고
    // "로딩중..." 상태로 두면 프로필 조회가 곧 진짜 이름으로 치환한다.
    if (creator?.nameSource !== "profile" && creator?.nameSource !== "manual") return "";
    // 찌꺼기(제작자 UUID 앞자리, 예: b1eeff2b / b1eeff2b… / b1eeff2b...)는 이름으로 취급하지 않는다.
    // 말줄임표·공백·점을 걷어낸 결과가 6자 이상 16진수이고 본인 id의 접두사면 차단.
    const id = String(creator?.id || "").toLowerCase().replace(/-/g, "");
    const compactName = name.toLowerCase().replace(/[\s\u2026.\-]/g, "");
    if (/^[0-9a-f]{6,}$/.test(compactName)) {
      if (!id || id.startsWith(compactName)) return "";
    }
    return name;
  }

  function isPossibleCreatorName(text) {
    const value = String(text || "").trim();
    if (!value || value.length > 24) return false;
    if (UUID_RE.test(value)) return false;
    if (/^(홈|추천|신작|랭킹|카테고리|태그|로그인|알림|공지|메모|평점|메모\/평점|숨김|보이기|링크|정보 확장|카드|리스트|책장|Creator|제작자)$/i.test(value)) return false;
    if (/^\d{2,12}$/.test(value)) return true;
    // UUID 조각처럼 보이는 16진수 문자열(숫자+a-f 혼합, 8자 이상)은 이름이 아니다.
    // 말줄임표(…)나 점이 붙은 잘린 형태도 동일하게 거부한다.
    {
      const hexish = value.replace(/[\s\u2026.]+$/, "");
      if (/^[0-9a-f]{8,32}$/i.test(hexish) && /\d/.test(hexish) && /[a-f]/i.test(hexish)) return false;
    }
    if (/^\d+(\.\d+)?(천|만)?$/.test(value)) return false;
    if (/^[\d.]+(천|만)?\s+/.test(value)) return false;
    if (/(대화|채팅|평균|유저|조회|납치|당한|시작|전체|인기)/.test(value) && /\s/.test(value)) return false;
    if (value.includes("#")) return false;
    return true;
  }

  function sanitizeCreatorName(value) {
    const text = compact(String(value || "")
      .replace(/\s*\|\s*캐릭터 제작자\s*\|\s*로판 AI\s*$/i, "")
      .replace(/\s*\|\s*로판 AI\s*$/i, ""), 40);
    return isPossibleCreatorName(text) ? text : "";
  }

  function queueCreatorLookup(id) {
    if (!id) return;
    if (creatorLookupDone.has(id) || creatorLookupQueued.has(id) || creatorLookupInFlight.has(id)) return;
    // 이전 조회가 실패해 쿨다운 중이면 아직 재시도하지 않는다 (곧 다음 패스에서 재시도)
    const retry = creatorLookupRetryAt.get(id);
    if (retry && Date.now() < retry.at) return;
    creatorLookupQueued.add(id);
    runCreatorLookupQueue();
  }

  async function runCreatorLookupQueue() {
    if (creatorLookupRunning) return;
    creatorLookupRunning = true;
    try {
      while (creatorLookupQueued.size) {
        const id = creatorLookupQueued.values().next().value;
        creatorLookupQueued.delete(id);
        creatorLookupInFlight.add(id);
        let profile = {};
        try {
          profile = await fetchCreatorProfile(id);
        } catch {
          profile = {};
        }
        creatorLookupInFlight.delete(id);
        if (profile.name) {
          // 이름 확보 성공 → 완료 처리(재조회 안 함)
          creatorLookupDone.add(id);
          creatorLookupRetryAt.delete(id);
          ensureCreator(id, profile);
          await saveState();
        } else {
          // 실패 → 완료 처리하지 않고 쿨다운 후 재시도 (지수 백오프, 최대 5분)
          const attempts = (creatorLookupRetryAt.get(id)?.attempts || 0) + 1;
          const delayMs = Math.min(5 * 60 * 1000, 8000 * Math.pow(2, attempts - 1));
          creatorLookupRetryAt.set(id, { at: Date.now() + delayMs, attempts });
          // following 등 이름 외 정보라도 있으면 반영
          if ("following" in profile) { ensureCreator(id, profile); await saveState(); }
        }
        applyEnhancements({ preserveEditors: true });
        if (!panel.hidden && panel.dataset.tab === "creator") renderPanel("creator");
      }
    } finally {
      creatorLookupRunning = false;
    }
  }

  async function fetchCreatorProfile(id) {
    try {
      const response = await fetch(`/user/${encodeURIComponent(id)}`, {
        credentials: "include",
        cache: "force-cache"
      });
      if (!response.ok) return {};
      return extractCreatorProfileFromHtml(await response.text());
    } catch {
      return {};
    }
  }

  function extractCreatorNameFromProfileHtml(html) {
    return extractCreatorProfileFromHtml(html).name || "";
  }

  function extractCreatorProfileFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const titleName = sanitizeCreatorName(doc.title || "");
    const metaTitle = doc.querySelector("meta[property='og:title'], meta[name='twitter:title']")?.content;
    const metaName = sanitizeCreatorName(metaTitle || "");
    const data = parseNextDataFromDocument(doc);
    const fromData = creatorProfileFromNextData(data);
    const name = titleName || metaName || fromData.name;
    // 배경 닉네임 조회는 force-cache라 로그인 안 된 캐시본을 읽을 수 있으므로
    // 팔로우/차단 등 관계 정보는 절대 반환하지 않는다(하트가 덮어써져 사라지는 것 방지).
    // 이름/이미지(로그인 무관)만 반환한다.
    const profile = {};
    if (name) {
      profile.name = name;
      profile.nameSource = "profile";
    }
    if (fromData.image) profile.image = fromData.image;
    return profile;
  }

  function parseNextDataFromDocument(doc) {
    const script = doc.querySelector("#__NEXT_DATA__");
    if (!script?.textContent) return null;
    try {
      return JSON.parse(script.textContent);
    } catch {
      return null;
    }
  }

  function currentUserId() {
    const data = parseNextData();
    const pageProps = data?.props?.pageProps || {};
    return pageProps.userData?.id || pageProps.user?.id || pageProps.currentUser?.id || "";
  }

  function createShell() {
    launcher = document.createElement("button");
    launcher.id = "rofan-helper-launcher";
    launcher.type = "button";
    launcher.innerHTML = `<span class="rh-launcher-mark">R+</span><span class="rh-launcher-version">v${esc(HELPER_VERSION)}</span>`;
    launcher.title = `Rofan AI Helper v${HELPER_VERSION} (드래그로 위치 이동)`;
    setupLauncherDrag(launcher);

    panel = document.createElement("section");
    panel.id = "rofan-helper-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <header class="rh-panel-head">
        <div class="rh-brand">
          <span class="rh-brand-badge">R+</span>
          <div>
            <strong>Rofan Helper <em>v${esc(HELPER_VERSION)}</em></strong>
            <span>${esc(location.hostname)} · 데이터는 내 브라우저에만 저장</span>
          </div>
        </div>
        <button type="button" data-action="close" title="닫기">×</button>
      </header>
      <nav class="rh-tabs" aria-label="Rofan Helper 메뉴"></nav>
      <div class="rh-panel-body"></div>
    `;
    panelBody = $(".rh-panel-body", panel);
    panel.addEventListener("click", handlePanelClick);
    panel.addEventListener("input", debounce(handlePanelInput, 200));
    // 체크박스 등 토글은 디바운스 없이 즉시 처리 (빠른 조작 시 유실 방지)
    panel.addEventListener("change", handlePanelChange);
    // details 토글(버블 안 됨) — 캡처로 받아 열림 상태를 세션 동안 유지
    panel.addEventListener("toggle", (event) => {
      const acc = event.target?.closest?.(".rh-acc");
      if (!acc) return;
      if (acc.open) chatSetOpenSections.add(acc.dataset.acc);
      else chatSetOpenSections.delete(acc.dataset.acc);
    }, true);
    document.documentElement.append(launcher, panel);
    applyLauncherPos();
    window.addEventListener("resize", clampLauncherIntoView);
  }

  // 저장된 위치를 런처에 적용 (없으면 CSS 기본값: 우하단)
  function applyLauncherPos() {
    const pos = state.settings.launcherPos;
    if (!launcher || !pos || typeof pos.left !== "number") return;
    launcher.style.left = `${pos.left}px`;
    launcher.style.top = `${pos.top}px`;
    launcher.style.right = "auto";
    launcher.style.bottom = "auto";
    clampLauncherIntoView();
  }

  function clampLauncherIntoView() {
    const pos = state.settings.launcherPos;
    if (!launcher || !pos || typeof pos.left !== "number") return;
    const w = launcher.offsetWidth || 72;
    const h = launcher.offsetHeight || 48;
    const left = Math.max(4, Math.min(window.innerWidth - w - 4, pos.left));
    const top = Math.max(4, Math.min(window.innerHeight - h - 4, pos.top));
    launcher.style.left = `${left}px`;
    launcher.style.top = `${top}px`;
  }

  // 드래그로 위치 이동 + (움직임이 거의 없으면) 클릭으로 패널 토글
  function setupLauncherDrag(el) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;

    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      const rect = el.getBoundingClientRect();
      baseLeft = rect.left;
      baseTop = rect.top;
      try { el.setPointerCapture?.(event.pointerId); } catch {}
    });

    el.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      el.classList.add("rh-launcher-dragging");
      const left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, baseLeft + dx));
      const top = Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 4, baseTop + dy));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    });

    const finish = async (event) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("rh-launcher-dragging");
      try { el.releasePointerCapture?.(event.pointerId); } catch {}
      if (moved) {
        const rect = el.getBoundingClientRect();
        state.settings.launcherPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        await saveState();
        repositionPanel();
      } else {
        togglePanel();
      }
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  }

  // 패널이 런처 근처에 뜨도록 위치 보정 (런처를 옮겼을 때)
  function repositionPanel() {
    if (!panel) return;
    const pos = state.settings.launcherPos;
    if (!pos || typeof pos.left !== "number") {
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      return;
    }
    const rect = launcher.getBoundingClientRect();
    const panelW = Math.min(420, window.innerWidth - 24);
    const panelH = Math.min(760, window.innerHeight - 102);
    let left = rect.left;
    if (left + panelW > window.innerWidth - 8) left = window.innerWidth - panelW - 8;
    left = Math.max(8, left);
    let top = rect.top - panelH - 10;
    if (top < 8) top = rect.bottom + 10;
    if (top + panelH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - panelH - 8);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function injectNaturalMenu() {
    if (!state.settings.pinnedMenu) return;
    if ($("#rofan-helper-nav-button")) return;
    const target = $("header nav") || $("nav") || $("header") || $("main");
    if (!target) return;
    const button = document.createElement("button");
    button.id = "rofan-helper-nav-button";
    button.type = "button";
    button.textContent = "Helper";
    button.title = "Rofan AI Helper 열기";
    button.addEventListener("click", () => togglePanel(true));
    target.append(button);
  }

  function togglePanel(forceOpen) {
    panel.hidden = forceOpen ? false : !panel.hidden;
    if (!panel.hidden) {
      renderPanel(panel.dataset.tab || "home");
      repositionPanel();
    }
  }

  function isOnboarded() {
    const ob = state.settings.onboarding || {};
    return Boolean(ob.chatListDone && ob.followsDone && ob.creatorCharsDone);
  }

  function renderPanel(tab = panel?.dataset.tab || "home") {
    if (!panelBody) return;
    // 최초 불러오기(대화목록·팔로우)가 끝나기 전에는 개인 기능 대신 온보딩 화면만 보여준다.
    if (!isOnboarded()) {
      $(".rh-tabs", panel).innerHTML = "";
      panelBody.innerHTML = renderOnboarding();
      return;
    }
    panel.dataset.tab = tab;
    const tabs = [
      ["home", "개요"],
      ["creator", "제작자"],
      ["chatset", "채팅설정"],
      ["etc", "기타설정"],
      ["data", "데이터"]
    ];
    $(".rh-tabs", panel).innerHTML = tabs.map(([id, label]) => (
      `<button type="button" data-tab="${id}" class="${tab === id ? "active" : ""}">${label}</button>`
    )).join("");

    const renderers = {
      home: renderHome,
      creator: renderCreator,
      chatset: renderChatSettings,
      etc: renderEtcSettings,
      data: renderData
    };
    panelBody.innerHTML = renderers[tab]?.() || renderHome();
  }

  // ===== 최초 불러오기(온보딩) =====

  const IMPORT_ACTION = { chatList: "import-chatlist", follows: "import-follows", creatorChars: "import-creatorchars" };

  function importDone(kind) {
    const ob = state.settings.onboarding || {};
    if (kind === "chatList") return Boolean(ob.chatListDone);
    if (kind === "follows") return Boolean(ob.followsDone);
    return Boolean(ob.creatorCharsDone);
  }

  function renderOnboarding() {
    const ob = state.settings.onboarding || {};
    const running = importState.running;
    const btn = (kind, label, extra = "") => {
      const done = importDone(kind);
      const isThis = running === kind;
      // 제작자 캐릭터 단계는 팔로우 불러오기가 끝난 뒤에만 가능(제작자 목록 필요).
      const needFollows = kind === "creatorChars" && !ob.followsDone;
      const disabled = done || Boolean(running) || needFollows;
      let status = "";
      if (isThis) status = `<span class="rh-ob-status run">진행중… ${esc(importProgressLine())}</span>`;
      else if (done) status = `<span class="rh-ob-status done">완료됨</span>`;
      else if (needFollows) status = `<span class="rh-ob-status">팔로우 불러오기 먼저</span>`;
      else if (running) status = `<span class="rh-ob-status">대기 중</span>`;
      return `
        <div class="rh-ob-row">
          <button type="button" class="rh-btn rh-ob-btn" data-action="${IMPORT_ACTION[kind]}" ${disabled ? "disabled" : ""}>${label}</button>
          ${status}
        </div>
        ${extra}`;
    };
    return `
      <div class="rh-ob">
        <h3>처음 오셨나요? 먼저 내 정보를 불러와 주세요</h3>
        <p class="rh-setting-desc">아래 <strong>세 가지</strong>를 모두 완료해야 개인 기능(오늘 플레이한 캐릭터·최근 본 캐릭터·통계·팔로우 제작자 등)이 열립니다. (메인 화면의 제작자 표시·대화수/사람수/평균 표시는 지금도 그대로 동작해요.)</p>
        ${btn("chatList", "대화한 캐릭터 불러오기")}
        ${btn("follows", "팔로우 불러오기")}
        ${btn("creatorChars", "제작자 캐릭터 불러오기", `<p class="rh-ob-sub">팔로우한 제작자 페이지를 넘겨가며 각 제작자의 캐릭터를 제작자와 연동합니다. (제작자가 많으면 오래 걸릴 수 있어요.)</p>`)}
        <p class="rh-ob-note">대화목록이 많거나 팔로우한 제작자가 많다면 시간이 오래 걸릴 수 있으며, 중간에 새로고침 등으로 취소하면 불러오기는 중단됩니다. (아직 불러오기를 이어하는 기능은 없습니다. 로판ai를 진행하면서 대화목록 페이지를 수동으로 확인하거나, 팔로우한 제작자의 캐릭터정보에서 제작자 이름을 한 번씩 눌러주면 불러오기가 완료됩니다.)</p>
      </div>`;
  }

  // 진행 상태(모듈 메모리). 새로고침하면 사라지고 크롤도 중단된다(이어하기 없음).
  const importState = { running: "", collected: 0, total: 0, page: 0, chars: 0 };

  const IMPORT_LABEL = { chatList: "대화한 캐릭터", follows: "팔로우", creatorChars: "제작자 캐릭터" };

  function importPercent() {
    if (importState.total > 0) return Math.min(100, Math.round((importState.collected / importState.total) * 100));
    return null;
  }

  function importProgressLine() {
    const pct = importPercent();
    if (importState.running === "creatorChars") {
      const base = importState.total
        ? `제작자 ${importState.collected} / ${importState.total} (${pct}%)`
        : `제작자 ${importState.collected}명`;
      return `${base} · 캐릭터 ${importState.chars || 0}개`;
    }
    const unit = importState.running === "follows" ? "명" : "개";
    if (pct !== null) return `${importState.collected} / ${importState.total}${unit} (${pct}%)`;
    return `${importState.collected}${unit} 수집 중… (${importState.page}페이지)`;
  }

  function updateOnboardingView() {
    if (panel && !panel.hidden && !isOnboarded()) {
      panelBody.innerHTML = renderOnboarding();
    }
    updateImportOverlay();
  }

  // ===== 불러오기 로딩 오버레이 / 완료 모달 =====

  function showImportOverlay(kind) {
    let ov = $("#rofan-helper-import-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "rofan-helper-import-overlay";
      document.documentElement.append(ov);
    }
    const title = `${IMPORT_LABEL[kind] || "불러오는"} 불러오는 중…`;
    ov.innerHTML = `
      <div class="rh-import-card" role="dialog" aria-live="polite">
        <div class="rh-import-spinner"></div>
        <h3 class="rh-import-title">${title}</h3>
        <div class="rh-import-bar"><div class="rh-import-fill" style="width:0%"></div></div>
        <p class="rh-import-line">시작하는 중…</p>
        <p class="rh-import-note">새로고침하거나 페이지를 이동하면 불러오기가 중단됩니다.</p>
      </div>`;
    updateImportOverlay();
  }

  function updateImportOverlay() {
    const ov = $("#rofan-helper-import-overlay");
    if (!ov || !importState.running) return;
    const fill = ov.querySelector(".rh-import-fill");
    const line = ov.querySelector(".rh-import-line");
    const pct = importPercent();
    if (fill) fill.style.width = pct !== null ? `${pct}%` : "100%";
    if (fill) fill.classList.toggle("rh-import-indeterminate", pct === null);
    if (line) line.textContent = importProgressLine();
  }

  function showImportComplete(kind, count) {
    let ov = $("#rofan-helper-import-overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "rofan-helper-import-overlay";
      document.documentElement.append(ov);
    }
    const unit = kind === "follows" ? "명" : "개";
    const what = kind === "follows" ? "팔로우 제작자" : (kind === "creatorChars" ? "제작자 캐릭터" : "대화한 캐릭터");
    const verb = kind === "creatorChars" ? "연동했어요" : "불러왔어요";
    const allDone = isOnboarded();
    ov.innerHTML = `
      <div class="rh-import-card" role="dialog">
        <div class="rh-import-check">✓</div>
        <h3 class="rh-import-title">${IMPORT_LABEL[kind] || ""} 불러오기 완료!</h3>
        <p class="rh-import-done-line">${what} <strong>${count}${unit}</strong>을(를) ${verb}.</p>
        ${allDone
          ? `<p class="rh-import-note">모든 불러오기가 끝나 개인 기능이 열렸어요!</p>`
          : `<p class="rh-import-note">남은 단계도 불러오면 개인 기능이 모두 열립니다.</p>`}
        <button type="button" class="rh-btn rh-import-ok" data-action="import-close">확인</button>
      </div>`;
    ov.querySelector(".rh-import-ok")?.addEventListener("click", () => {
      hideImportOverlay();
      if (isOnboarded()) renderPanel("home"); else updateOnboardingView();
    });
  }

  function hideImportOverlay() {
    $("#rofan-helper-import-overlay")?.remove();
  }

  // 페이지 HTML을 받아 __NEXT_DATA__의 pageProps를 반환
  async function fetchPageProps(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const data = parseNextDataFromDocument(doc);
    return data?.props?.pageProps || null;
  }

  // 트리에서 배열들 중 "대화방/봇" 항목이 담긴 배열을 찾아 반환(가장 큰 것)
  function firstArrayOf(value, predicate) {
    let best = null;
    const visit = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        if (v.length && v.every(predicate) && (!best || v.length > best.length)) best = v;
        v.forEach(visit);
        return;
      }
      Object.values(v).forEach(visit);
    };
    visit(value);
    return best || [];
  }

  // 팔로우 페이지에서 "제작자" 객체들을 찾아낸다(id + 닉네임/프로필이 있는 것)
  function findFollowedCreators(pageProps) {
    const arr = firstArrayOf(pageProps, (o) =>
      o && typeof o === "object" &&
      (o.id || o.user_id || o.creator_id || o.userId) &&
      (o.nickname || o.name || o.displayName || o.profile || o.profile_image)
    );
    const out = [];
    arr.forEach((o) => {
      const id = firstText(o.id, o.user_id, o.creator_id, o.userId);
      if (!id || !UUID_RE.test(id)) return;
      out.push({
        id,
        name: sanitizeCreatorName(o.nickname || o.name || o.displayName || ""),
        image: firstText(o.profile, o.profile_image, o.image)
      });
    });
    return out;
  }

  async function runImport(kind) {
    if (importState.running) return;
    if (kind === "creatorChars" && !state.settings.onboarding?.followsDone) return; // 팔로우 먼저
    // 클릭 즉시 "완료" 처리(한 번의 기회) + 버튼 비활성화. 중단돼도 이어하지 않음.
    const ob = state.settings.onboarding || (state.settings.onboarding = {});
    if (kind === "chatList") ob.chatListDone = true;
    else if (kind === "follows") ob.followsDone = true;
    else ob.creatorCharsDone = true;
    importState.running = kind;
    importState.collected = 0;
    importState.total = 0;
    importState.page = 0;
    importState.chars = 0;
    await saveState();
    showImportOverlay(kind);   // 화면 어둡게 + 로딩 모달
    updateOnboardingView();

    let count = 0;
    try {
      if (kind === "chatList") count = await crawlChatList();
      else if (kind === "follows") count = await crawlFollows();
      else count = await crawlCreatorChars();
    } catch (error) {
      console.error("[Rofan Helper] import failed", error);
    } finally {
      importState.running = "";
      await saveState();
      showImportComplete(kind, count); // 완료 모달(확인 버튼)
      updateOnboardingView();
    }
  }

  // 팔로우한 각 제작자 페이지를 넘겨가며 그 제작자의 캐릭터를 제작자와 연동한다.
  async function crawlCreatorChars() {
    const creators = Object.values(state.creators).filter((c) => c.following);
    importState.total = creators.length;
    importState.collected = 0;
    importState.chars = 0;
    const globalSeen = new Set();
    for (const creator of creators) {
      if (importState.running !== "creatorChars") break;
      await crawlOneCreatorChars(creator.id, globalSeen);
      importState.collected += 1;
      updateOnboardingView();
    }
    await saveState();
    return globalSeen.size;
  }

  async function crawlOneCreatorChars(creatorId, globalSeen) {
    if (!creatorId || !UUID_RE.test(creatorId)) return;
    const localSeen = new Set();
    let page = 1;
    let total = Infinity;
    while (page <= 500 && importState.running === "creatorChars") {
      const pp = await fetchPageProps(`/user/${encodeURIComponent(creatorId)}?page=${page}`);
      if (!pp) break;
      const t = toNumber(pp.totalBots ?? pp.totalCharacters ?? pp.botCount);
      if (t) total = t;
      // 이 제작자 페이지의 봇들(대화방 신호 없는 bot_id+char). 다른 제작자 봇은 제외.
      const bots = firstArrayOf(pp, (o) =>
        o && typeof o === "object" && o.bot_id && (o.char || o.name) &&
        !(o.chat_id || o.chat_title || o.bot_chat)
      );
      if (!bots.length) break;
      let newLocal = 0;
      bots.forEach((b) => {
        const bid = firstText(b.bot_id, b.botId);
        if (!bid || !UUID_RE.test(bid)) return;
        const ownCreator = creatorIdFromBot(b);
        if (ownCreator && ownCreator !== creatorId) return; // 다른 제작자 봇(추천 등)은 연동하지 않음
        const patch = { creatorId };
        const name = firstText(b.char, b.name);
        if (name && !UUID_RE.test(name)) patch.name = name;
        const image = firstText(b.char_image, b.image, b.thumbnail, b.profile);
        if (image) patch.image = image;
        ensureCharacter(bid, patch);
        globalSeen.add(bid);
        if (!localSeen.has(bid)) { localSeen.add(bid); newLocal += 1; }
      });
      importState.chars = globalSeen.size;
      updateOnboardingView();
      if (newLocal === 0) break;                       // 새 캐릭터 없음 → 마지막(또는 페이지 클램프)
      if (total !== Infinity && localSeen.size >= total) break;
      page += 1;
    }
  }

  async function crawlChatList() {
    const MAX = 2000;
    let collected = 0;
    const chars = new Set(); // 고유 캐릭터 수(완료 메시지에 사용)
    importState.total = 0;
    while (importState.page < MAX && importState.running === "chatList") {
      importState.page += 1;
      const pp = await fetchPageProps(`/chat-list?page=${importState.page}`);
      if (!pp) break;
      const t = toNumber(pp.totalChats ?? pp.totalAllChats);
      if (t) importState.total = t;
      const rooms = firstArrayOf(pp, (o) => o && typeof o === "object" && (o.chat_id || o.chat_title || o.bot_chat || (o.bot_id && o.char)));
      if (!rooms.length) break;
      ingestHookApiData(pp);
      rooms.forEach((r) => { const b = firstText(r.bot_id, r.botId); if (b) chars.add(b); });
      collected += rooms.length;
      importState.collected = collected;
      updateOnboardingView();
      if ((importState.total && collected >= importState.total) || rooms.length < 12) break;
    }
    await saveState();
    return chars.size; // 대화한 "캐릭터" 수
  }

  // 제작자 탭에서 팔로우 목록을 다시 불러오기(온보딩 이후 새로고침/복구용).
  async function refreshFollows() {
    if (importState.running) return;
    importState.running = "follows";
    importState.collected = 0;
    importState.total = 0;
    importState.page = 0;
    showImportOverlay("follows");
    let count = 0;
    try {
      count = await crawlFollows();
    } catch (error) {
      console.error("[Rofan Helper] refresh follows failed", error);
    } finally {
      importState.running = "";
      await saveState();
      showImportComplete("follows", count);
      // 완료 모달 [확인] 시 제작자 탭으로 돌아가도록 표시(refreshComplete 플래그)
      const ov = $("#rofan-helper-import-overlay");
      ov?.querySelector(".rh-import-ok")?.addEventListener("click", () => renderPanel("creator"), { once: true });
    }
  }

  async function crawlFollows() {
    const MAX = 2000;
    let collected = 0;
    importState.total = 0;
    while (importState.page < MAX && importState.running === "follows") {
      importState.page += 1;
      const pp = await fetchPageProps(`/following-users?page=${importState.page}`);
      if (!pp) break;
      const t = toNumber(pp.totalFollows ?? pp.totalFollowing ?? pp.totalCount ?? pp.total);
      if (t) importState.total = t;
      const creators = findFollowedCreators(pp);
      if (!creators.length) break;
      creators.forEach((c) => {
        const patch = { following: true };
        if (c.name) { patch.name = c.name; patch.nameSource = "profile"; }
        if (c.image) patch.image = c.image;
        ensureCreator(c.id, patch);
      });
      collected += creators.length;
      importState.collected = collected;
      updateOnboardingView();
      if ((importState.total && collected >= importState.total) || creators.length < 10) break; // 마지막 페이지(10명/페이지)
    }
    await saveState();
    return collected;
  }

  function renderHome() {
    return `
      <h3>플레이 캘린더</h3>
      ${renderCalendar()}
      <h3>오늘 플레이한 캐릭터</h3>
      ${renderCharacterCarousel(todayPlayedCharacters(), "오늘 플레이한 캐릭터가 없어요.")}
      <h3>최근 본 캐릭터</h3>
      ${renderCharacterCarousel(recentViewedCharacters(), "아직 최근 본 캐릭터가 없어요.")}
      <h3>플레이 통계</h3>
      ${renderStats()}
    `;
  }

  function todayPlayedCharacters() {
    const t = today();
    const ids = [];
    state.playLog.forEach((item) => {
      if (item.date === t && item.characterId && !ids.includes(item.characterId)) ids.push(item.characterId);
    });
    return ids.map((id) => state.characters[id]).filter(Boolean);
  }

  function recentViewedCharacters() {
    return state.recentCharacterIds.map((id) => state.characters[id]).filter(Boolean).slice(0, 20);
  }

  function renderCharacterCarousel(items, emptyMsg) {
    if (!items.length) return empty(emptyMsg);
    return `
      <div class="rh-carousel">
        <button type="button" class="rh-carousel-nav" data-action="carousel-prev" aria-label="이전">&#8249;</button>
        <div class="rh-carousel-track">
          ${items.map(characterChip).join("")}
        </div>
        <button type="button" class="rh-carousel-nav" data-action="carousel-next" aria-label="다음">&#8250;</button>
      </div>
    `;
  }

  function characterChip(item) {
    const name = item.name || "이름 확인 중";
    return `
      <button type="button" class="rh-char-chip" data-action="open-character" data-id="${esc(item.id)}" title="${esc(name)}">
        ${characterAvatar(item, "rh-char-chip-img")}
        <span class="rh-char-chip-name">${esc(name)}</span>
      </button>
    `;
  }

  function characterAvatar(item, className) {
    if (item.image) {
      return `<span class="${esc(className)} rh-char-avatar"><img src="${esc(item.image)}" alt="" loading="lazy"></span>`;
    }
    const letter = firstAvatarLetter(item.name || "R");
    const color = roomAvatarColor(item.name || item.id);
    return `<span class="${esc(className)} rh-char-avatar rh-char-avatar-fallback" style="--rh-room-avatar-bg:${esc(color)}">${esc(letter)}</span>`;
  }

  function metric(label, value) {
    return `<div class="rh-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function metricBtn(label, value, key) {
    return `<button type="button" class="rh-metric rh-metric-btn${dataSection === key ? " active" : ""}" data-action="data-section" data-section="${esc(key)}"><span>${esc(label)}</span><strong>${esc(value)}</strong></button>`;
  }

  function empty(text) {
    return `<p class="rh-empty">${esc(text)}</p>`;
  }

  function characterRow(item) {
    const creator = item.creatorId ? state.creators[item.creatorId] : null;
    const creatorLabel = creatorDisplayName(creator);
    const sub = [creatorLabel && `제작자 ${creatorLabel}`, item.played && "플레이 중"].filter(Boolean).join(" · ");
    const rating = item.rating ? `<span class="rh-rating">${"★".repeat(item.rating)}</span>` : "";
    return `
      <div class="rh-row">
        <button type="button" data-action="open-character" data-id="${esc(item.id)}">
          <strong>${esc(item.name || "이름 확인 중")}</strong>
          ${sub ? `<small>${esc(sub)}</small>` : ""}
        </button>
        ${rating}
      </div>
    `;
  }

  function hiddenCharacterRow(item) {
    return `
      <div class="rh-row">
        <button type="button" data-action="open-character" data-id="${esc(item.id)}">
          <strong>${esc(item.name || "이름 확인 중")}</strong>
          <small>숨김 처리됨</small>
        </button>
        <button type="button" data-action="unhide-character" data-id="${esc(item.id)}">보이기</button>
      </div>
    `;
  }

  function renderCreator() {
    const following = Object.values(state.creators).filter((item) => item.following);
    return `
      <div class="rh-creator-head">
        <h3>팔로우중인 제작자</h3>
        <button type="button" class="rh-refresh-follows" data-action="refresh-follows" title="팔로우 목록을 사이트에서 다시 불러옵니다">↻ 다시 불러오기</button>
      </div>
      ${following.length
        ? following.map(followingCreatorCard).join("")
        : empty("팔로우중인 제작자가 없어요. ↻ 다시 불러오기로 사이트의 팔로우 목록을 가져오거나, 카드의 제작자 이름을 눌러 팔로우하면 여기 모여요.")}
    `;
  }

  function followingCreatorCard(creator) {
    const label = creatorDisplayName(creator) || "제작자";
    const playedChars = Object.values(state.characters).filter((ch) => ch.creatorId === creator.id && ch.played);
    return `
      <div class="rh-creator-card">
        <div class="rh-creator-card-head">
          ${creatorAvatar(creator)}
          <button type="button" class="rh-creator-card-name" data-action="open-creator-page" data-id="${esc(creator.id)}" title="제작자 페이지로 이동">${esc(label)}</button>
          <button type="button" class="rh-creator-memo-btn" data-action="creator-memo-toggle" data-id="${esc(creator.id)}" title="메모">✎</button>
          <button type="button" class="rh-creator-unfollow" data-action="creator-unfollow" data-id="${esc(creator.id)}">언팔로우</button>
        </div>
        <div class="rh-creator-memo-edit" data-creator-memo="${esc(creator.id)}"${creator.note ? "" : " hidden"}>
          <textarea data-field="creator-note" data-id="${esc(creator.id)}" placeholder="제작자 메모를 남겨두세요.">${esc(creator.note || "")}</textarea>
          <button type="button" class="rh-btn rh-creator-note-save" data-action="save-creator-note" data-id="${esc(creator.id)}">저장</button>
        </div>
        ${playedChars.length ? `
          <div class="rh-creator-played">
            <span class="rh-creator-played-label">플레이중인 캐릭터</span>
            <div class="rh-creator-played-list">
              ${playedChars.map((ch) => `
                <button type="button" class="rh-char-chip rh-char-chip-sm" data-action="open-character" data-id="${esc(ch.id)}" title="${esc(ch.name || "")}">
                  ${characterAvatar(ch, "rh-char-chip-img")}
                  <span class="rh-char-chip-name">${esc(ch.name || "이름 확인 중")}</span>
                </button>
              `).join("")}
            </div>
          </div>` : ""}
      </div>
    `;
  }

  function creatorAvatar(creator) {
    if (creator?.image) {
      return `<span class="rh-creator-avatar rh-creator-avatar-img"><img src="${esc(creator.image)}" alt="" loading="lazy"></span>`;
    }
    const label = creatorDisplayName(creator) || "?";
    const color = roomAvatarColor(creator.id || label);
    return `<span class="rh-creator-avatar" style="--rh-room-avatar-bg:${esc(color)}">${esc(firstAvatarLetter(label))}</span>`;
  }

  function renderData() {
    const total = Object.keys(state.characters).length;
    const played = Object.values(state.characters).filter((item) => item.played).length;
    const hidden = Object.values(state.characters).filter((item) => item.hidden).length;
    const creators = Object.keys(state.creators).length;
    return `
      <div class="rh-actions">
        <button type="button" data-action="export-data">전체 데이터 내보내기</button>
        <button type="button" data-action="import-data">가져오기</button>
      </div>
      <textarea data-field="import-json" placeholder="가져올 JSON을 붙여넣고 가져오기를 누르세요."></textarea>
      <h3>수집 현황 (숫자를 눌러 목록 보기)</h3>
      <div class="rh-grid">
        ${metricBtn("수집 캐릭터", total, "characters")}
        ${metricBtn("플레이", played, "played")}
        ${metricBtn("숨김", hidden, "hidden")}
        ${metricBtn("제작자", creators, "creators")}
        ${metricBtn("NAI 생성", (state.naiHistory || []).length, "naihistory")}
        ${metricBtn("NAI 외형", Object.values(state.characters).filter((c) => c.appearance).length, "appearance")}
      </div>
      ${renderDataSection()}
    `;
  }

  function renderDataSection() {
    if (dataSection === "characters") return dataListSection("수집 캐릭터", Object.values(state.characters), characterRow);
    if (dataSection === "played") return dataListSection("플레이한 캐릭터", Object.values(state.characters).filter((c) => c.played), characterRow);
    if (dataSection === "hidden") return dataListSection("숨긴 캐릭터", Object.values(state.characters).filter((c) => c.hidden), hiddenCharacterRow);
    if (dataSection === "creators") return dataListSection("제작자 컬렉션", Object.values(state.creators), creatorCollectionRow);
    if (dataSection === "naihistory") return renderNaiHistorySection();
    if (dataSection === "appearance") return renderAppearanceSection();
    return "";
  }

  function renderNaiHistorySection() {
    const items = [...(state.naiHistory || [])].reverse();
    return `
      <h3>NAI 생성 이력 (${items.length}) ${items.length ? `<button type="button" class="rh-btn rh-btn-ghost rh-btn-sm" data-action="nai-hist-clear">전체 삭제</button>` : ""}</h3>
      <p class="rh-setting-desc">생성된 원본 이미지는 <strong>다운로드 폴더 › RofanHelper › NAI</strong> 에 자동 저장됩니다. <button type="button" class="rh-btn rh-btn-ghost rh-btn-sm" data-action="nai-open-folder">다운로드 폴더 열기</button></p>
      ${items.length ? `
        <div class="rh-carousel rh-nai-carousel">
          <button type="button" class="rh-carousel-nav" data-action="carousel-prev" aria-label="이전">&#8249;</button>
          <div class="rh-carousel-track rh-nai-track">
            ${items.map((h) => `
              <div class="rh-nai-tile" title="${esc(h.roomTitle || "대화방")} · ${esc(fmtDate(h.createdAt))}${h.seed ? ` · 시드 ${esc(String(h.seed))}` : ""}
${esc(h.aiPrompt)}">
                ${h.thumb ? `<img class="rh-nai-tile-img" src="${esc(h.thumb)}" alt="">` : `<span class="rh-nai-tile-img rh-nai-hist-noimg">P</span>`}
                <button type="button" class="rh-nai-tile-copy" data-action="nai-copy-prompt" data-id="${esc(h.id)}">프롬복사</button>
                <button type="button" class="rh-nai-tile-del" data-action="nai-hist-del" data-id="${esc(h.id)}" title="삭제">✕</button>
              </div>`).join("")}
          </div>
          <button type="button" class="rh-carousel-nav" data-action="carousel-next" aria-label="다음">&#8250;</button>
        </div>` : empty("아직 생성 이력이 없어요.")}
    `;
  }

  function copyNaiPrompt(id) {
    const entry = (state.naiHistory || []).find((h) => h.id === id);
    if (!entry) return;
    const text = entry.aiPrompt || "";
    const done = () => showToast("프롬프트를 복사했어요.");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { legacyCopy(text); done(); });
    } else {
      legacyCopy(text);
      done();
    }
  }

  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.append(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }

  function renderAppearanceSection() {
    const items = Object.values(state.characters).filter((c) => c.appearance);
    return `
      <h3>NAI 캐릭터 외형 (${items.length})</h3>
      <div class="rh-list">
        ${items.length ? items.map((c) => `
          <div class="rh-nai-appearance-row">
            <strong>${esc(c.name || "이름 미확인")}</strong>
            <textarea data-appearance-id="${esc(c.id)}">${esc(c.appearance)}</textarea>
            <button type="button" class="rh-btn rh-btn-sm" data-action="save-appearance-row" data-id="${esc(c.id)}">저장</button>
          </div>`).join("") : empty("저장된 외형 프롬프트가 없어요. 대화방에서 첫 이미지 생성 시 입력돼요.")}
      </div>
    `;
  }

  function dataListSection(title, items, rowFn) {
    return `
      <h3>${esc(title)} (${items.length})</h3>
      <div class="rh-list">
        ${items.length ? items.slice(0, 100).map(rowFn).join("") : empty("아직 없어요.")}
      </div>
    `;
  }

  function creatorCollectionRow(item) {
    return `
      <div class="rh-row">
        <span>${esc(creatorDisplayName(item) || "닉네임 미지정")}</span>
        <small>${item.following ? "팔로우 중" : ""}</small>
      </div>
    `;
  }

  // 기타설정 탭
  function renderEtcSettings() {
    const fc = state.settings.chatCardFolderColor || {};
    const none = !fc.background && !fc.border;
    return `
      <h3>대화</h3>
      <p class="rh-setting-desc">폴더 설정 색상을 대화목록의 대화 카드에 적용합니다. 배경은 은은하게(약 8%), 테두리는 외곽선으로 표시돼요. (미적용은 단독, 배경·테두리는 중복 가능)</p>
      <div class="rh-seg">
        <button type="button" class="rh-seg-btn${none ? " active" : ""}" data-action="folder-color-mode" data-mode="none">미적용</button>
        <button type="button" class="rh-seg-btn${fc.background ? " active" : ""}" data-action="folder-color-mode" data-mode="background">배경</button>
        <button type="button" class="rh-seg-btn${fc.border ? " active" : ""}" data-action="folder-color-mode" data-mode="border">테두리</button>
      </div>
    `;
  }

  // 채팅설정 탭
  // 채팅설정 아코디언 열림 상태 (세션 유지)
  const chatSetOpenSections = new Set(["fixed"]);

  function accSection(id, title, badge, bodyHtml) {
    return `
      <details class="rh-acc" data-acc="${id}" ${chatSetOpenSections.has(id) ? "open" : ""}>
        <summary><span>${title}</span>${badge ? `<em class="rh-acc-badge">${badge}</em>` : ""}</summary>
        <div class="rh-acc-body">${bodyHtml}</div>
      </details>`;
  }

  function renderChatSettings() {
    const ci = state.settings.chatInput || {};
    const sc = state.settings.shortcuts || {};
    const c = naiConfig();
    return `
      ${accSection("fixed", "대화 입력 고정 인풋", ci.fixedEnabled ? "ON" : "", renderFixedInputSettings())}
      ${accSection("shortcut", "단축어 (치환)", sc.enabled ? "ON" : "", renderShortcutSettings())}
      ${accSection("promptai", "프롬프트 생성 AI", aiCfgFor(c.aiProvider).key ? esc(c.aiProvider) : "", renderPromptAiSettings())}
      ${accSection("imggen", "이미지 생성 AI", c.enabled ? "ON" : "", renderImageGenSettings())}
    `;
  }

  function renderFixedInputSettings() {
    const ci = state.settings.chatInput || {};
    const text = ci.fixedText || "";
    const count = buildFixedInputMarkup(text).length;
    const hasBracket = /[<>]/.test(text);
    return `
      <p class="rh-setting-desc">활성화하면 메시지를 전송할 때(엔터/전송) API 전송 직전에 아래 내용을 <code>&lt;!--내용--&gt;</code> 형태(HTML 주석)로 함께 보냅니다. 주석이라 채팅창에는 보이지 않고 AI에게만 전달돼요.</p>
      <label class="rh-check">
        <input type="checkbox" data-field="chat-fixed-enabled" ${ci.fixedEnabled ? "checked" : ""}>
        고정 인풋 사용
      </label>
      <label>고정 인풋 내용
        <textarea data-field="chat-fixed-text" placeholder="매 메시지에 숨겨서 함께 보낼 내용">${esc(text)}</textarea>
      </label>
      <p class="rh-setting-warn" ${hasBracket ? "" : "hidden"}>&lt; 또는 &gt; 는 고정 인풋 내용에 사용할 수 없어요. 저장 시 전각 문자(＜ ＞)로 대체됩니다.</p>
      <div class="rh-setting-row">
        <p class="rh-setting-count">전송에 추가되는 글자수: <strong>${count}</strong>자 <span>(주석 &lt;!-- --&gt; 포함)</span></p>
        <button type="button" class="rh-btn" data-action="save-fixed-input">저장</button>
      </div>
    `;
  }

  function renderShortcutSettings() {
    const sc = state.settings.shortcuts || {};
    const list = Array.isArray(sc.list) ? sc.list : [];
    return `
      <p class="rh-setting-desc">채팅창에서 <code>/</code>를 입력하면 등록한 단축어 목록이 뜹니다. <code>/명령어</code>를 넣고 전송하면, 전송 직전에 그 <strong>단축어가 실제 내용으로 치환</strong>되어 AI에게 전달돼요. (채팅방 화면에는 입력한 <code>/명령어</code> 그대로 보일 수 있어요.)</p>
      <label class="rh-check">
        <input type="checkbox" data-field="shortcut-enabled" ${sc.enabled ? "checked" : ""}>
        단축어 사용
      </label>
      <label class="rh-check">
        <input type="checkbox" data-field="shortcut-chips" ${sc.showChips !== false ? "checked" : ""}>
        입력창에 <code>[/명령어]</code> 칩으로 표시(간소화)
      </label>
      <div class="rh-sc-list">
        ${list.length
          ? list.map((s, i) => `
            <div class="rh-sc-item">
              <div class="rh-sc-item-main">
                <span class="rh-sc-trigger">/${esc(s.trigger || "")}</span>
                <span class="rh-sc-content">${esc(s.content || "")}</span>
              </div>
              <button type="button" class="rh-sc-del" data-action="shortcut-del" data-index="${i}" title="삭제">✕</button>
            </div>`).join("")
          : `<p class="rh-setting-desc" style="margin:8px 0">아직 등록된 단축어가 없어요.</p>`}
      </div>
      <div class="rh-sc-add">
        <div class="rh-sc-add-row">
          <span class="rh-sc-slash">/</span>
          <input type="text" class="rh-sc-new-trigger" placeholder="명령어 (예: 노래)" maxlength="30">
        </div>
        <textarea class="rh-sc-new-content" placeholder="치환될 내용 (예: {{user}}는 노래를 불렀다. 노래를 묘사하시오.)"></textarea>
        <button type="button" class="rh-btn" data-action="shortcut-add">단축어 추가</button>
      </div>
    `;
  }

  // 주석을 깨뜨리는 < / > 는 전각 문자로 대체한다 ('>'만 바꿔도 -->/<!-- 조기 종료를 막을 수 있음)
  function sanitizeFixedInput(text) {
    return String(text || "").replace(/</g, "＜").replace(/>/g, "＞");
  }

  // 실제로 전송에 붙는 마크업 (글자수 카운트와 실제 주입이 동일해야 함)
  function buildFixedInputMarkup(text) {
    const t = sanitizeFixedInput(text);
    if (!t) return "";
    return `<!--${t}-->`;
  }

  // page-hook(MAIN world)에 고정 인풋 설정을 전달 → CreateMessage 전송 직전 주입에 사용
  function pushChatInjectConfig() {
    try {
      const ci = state.settings.chatInput || {};
      const markup = ci.fixedEnabled ? buildFixedInputMarkup(ci.fixedText || "") : "";
      window.dispatchEvent(new CustomEvent("rofan-helper:chat-inject", {
        detail: JSON.stringify({ enabled: Boolean(ci.fixedEnabled && markup), markup })
      }));
    } catch {
      // 전달 실패는 무시
    }
    updateChatCounterOffset();
  }

  // page-hook에 단축어 목록/사용여부를 전달 → CreateMessage 전송 직전 치환에 사용
  function pushShortcutsConfig() {
    try {
      const sc = state.settings.shortcuts || {};
      const list = (Array.isArray(sc.list) ? sc.list : [])
        .filter((s) => s && s.trigger && s.content)
        .map((s) => ({ trigger: String(s.trigger), content: String(s.content) }));
      window.dispatchEvent(new CustomEvent("rofan-helper:shortcuts", {
        detail: JSON.stringify({ enabled: Boolean(sc.enabled && list.length), list })
      }));
    } catch {
      // 전달 실패는 무시
    }
    updateShortcutUI();
  }

  function shortcutList() {
    const sc = state.settings.shortcuts || {};
    return (Array.isArray(sc.list) ? sc.list : []).filter((s) => s && s.trigger && s.content);
  }

  // 채팅 페이지: 실제 전송될 글자수(입력 + 고정 인풋)를 입력창 옆 칩으로 보여준다.
  function findMainChatInput() {
    if (!/\/chat\//.test(location.pathname)) return null;
    const areas = $$("textarea").filter((el) => isVisible(el) && !isHelperElement(el));
    if (!areas.length) return null;
    // 가장 아래쪽(전송 입력창)을 고른다
    return areas.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }

  function updateChatCounterOffset() {
    const ci = state.settings.chatInput || {};
    const input = findMainChatInput();
    if (!ci.fixedEnabled || !input) {
      $("#rofan-helper-chat-counter")?.remove();
      return;
    }
    if (input.dataset.rhCounterBound !== "1") {
      input.dataset.rhCounterBound = "1";
      const handler = () => renderChatCounterChip(input);
      input.addEventListener("input", handler);
      input.addEventListener("focus", handler);
      input.addEventListener("blur", () => setTimeout(handler, 50));
    }
    renderChatCounterChip(input);
  }

  function renderChatCounterChip(input) {
    const ci = state.settings.chatInput || {};
    if (!ci.fixedEnabled || !input || !document.contains(input)) {
      $("#rofan-helper-chat-counter")?.remove();
      return;
    }
    const typed = (input.value || "").length;
    const fixed = buildFixedInputMarkup(ci.fixedText || "").length;
    let chip = $("#rofan-helper-chat-counter");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "rofan-helper-chat-counter";
      document.documentElement.append(chip);
    }
    chip.innerHTML = `전송 <strong>${typed + fixed}</strong>자 <span>(입력 ${typed} + 고정 ${fixed})</span>`;
    const rect = input.getBoundingClientRect();
    chip.style.left = `${Math.max(8, rect.right - chip.offsetWidth - 4)}px`;
    chip.style.top = `${Math.max(8, rect.top - 26)}px`;
  }

  // ===== /단축어 자동완성 + 미리보기 칩 =====

  function escapeRegexJs(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // React 제어 textarea 값 갱신(네이티브 setter + input 이벤트로 onChange 유발)
  function setNativeValue(el, value) {
    try {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      desc.set.call(el, value);
    } catch {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let scDropdown = null;
  let scActiveIndex = 0;

  function updateShortcutUI() {
    const sc = state.settings.shortcuts || {};
    const input = findMainChatInput();
    if (!sc.enabled || !input || !shortcutList().length) {
      removeScDropdown();
      removeScChips();
      return;
    }
    if (input.dataset.rhScBound !== "1") {
      input.dataset.rhScBound = "1";
      input.addEventListener("input", onScInput);
      input.addEventListener("keydown", onScKeydown, true); // capture: 사이트의 Enter 전송보다 먼저
      input.addEventListener("blur", () => setTimeout(removeScDropdown, 160));
    }
    renderScChips(input);
  }

  // 캐럿 바로 앞 토큰이 /로 시작하는지 판정
  function currentSlashToken(input) {
    const val = input.value || "";
    const caret = input.selectionStart ?? val.length;
    const before = val.slice(0, caret);
    const m = before.match(/(^|\s)\/([^\s/]*)$/);
    if (!m) return null;
    const query = m[2];
    return { start: caret - query.length - 1, caret, query };
  }

  function onScInput(event) {
    const input = event.target;
    const sc = state.settings.shortcuts || {};
    if (!sc.enabled) { removeScDropdown(); removeScChips(); return; }
    const tok = currentSlashToken(input);
    const matches = tok
      ? shortcutList().filter((s) => s.trigger.toLowerCase().startsWith(tok.query.toLowerCase()))
      : [];
    if (tok && matches.length) {
      showScDropdown(input, matches, tok);
      removeScChips(); // 드롭다운 뜰 땐 칩 숨김(겹침 방지)
    } else {
      removeScDropdown();
      renderScChips(input);
    }
  }

  function showScDropdown(input, matches, tok) {
    if (!scDropdown) {
      scDropdown = document.createElement("div");
      scDropdown.id = "rofan-helper-sc-dropdown";
      document.documentElement.append(scDropdown);
    }
    const dd = scDropdown;
    if (scActiveIndex >= matches.length) scActiveIndex = 0;
    dd._matches = matches;
    dd._token = tok;
    dd._input = input;
    dd.innerHTML = matches.map((s, i) => `
      <button type="button" class="rh-sc-opt${i === scActiveIndex ? " active" : ""}" data-i="${i}">
        <span class="rh-sc-opt-trigger">/${esc(s.trigger)}</span>
        <span class="rh-sc-opt-content">${esc(s.content)}</span>
      </button>`).join("");
    dd.querySelectorAll(".rh-sc-opt").forEach((btn) => {
      // mousedown + preventDefault: 클릭 시 입력창 blur 전에 삽입
      btn.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        selectShortcut(input, matches[Number(btn.dataset.i)], tok);
      });
    });
    const r = input.getBoundingClientRect();
    dd.style.left = `${Math.round(r.left)}px`;
    dd.style.width = `${Math.round(Math.max(220, r.width))}px`;
    dd.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
    dd.style.display = "block";
  }

  function refreshScActive() {
    if (!scDropdown) return;
    scDropdown.querySelectorAll(".rh-sc-opt").forEach((b, i) => b.classList.toggle("active", i === scActiveIndex));
    scDropdown.querySelector(".rh-sc-opt.active")?.scrollIntoView({ block: "nearest" });
  }

  function onScKeydown(event) {
    const dd = scDropdown;
    if (!dd || dd.style.display === "none") return;
    const matches = dd._matches || [];
    if (!matches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault(); event.stopPropagation();
      scActiveIndex = (scActiveIndex + 1) % matches.length; refreshScActive();
    } else if (event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      scActiveIndex = (scActiveIndex - 1 + matches.length) % matches.length; refreshScActive();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault(); event.stopPropagation();
      selectShortcut(dd._input, matches[scActiveIndex], dd._token);
    } else if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      removeScDropdown();
    }
  }

  function selectShortcut(input, s, tok) {
    if (!s || !tok) return;
    const val = input.value || "";
    const insert = `/${s.trigger} `;
    setNativeValue(input, val.slice(0, tok.start) + insert + val.slice(tok.caret));
    const pos = tok.start + insert.length;
    try { input.setSelectionRange(pos, pos); } catch {}
    input.focus();
    scActiveIndex = 0;
    removeScDropdown();
    renderScChips(input);
  }

  function removeScDropdown() {
    if (scDropdown) scDropdown.style.display = "none";
  }

  // 입력창에 들어있는 /명령어 토큰들을 [/명령어] 칩으로 미리보기(호버 시 치환 내용)
  function findShortcutTokensInText(text) {
    return shortcutList().filter((s) => new RegExp("(^|\\s)\\/" + escapeRegexJs(s.trigger) + "(?=\\s|$)").test(text));
  }

  function renderScChips(input) {
    const sc = state.settings.shortcuts || {};
    if (!sc.enabled || sc.showChips === false) { removeScChips(); return; }
    const tokens = findShortcutTokensInText(input.value || "");
    if (!tokens.length) { removeScChips(); return; }
    let bar = $("#rofan-helper-sc-chips");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "rofan-helper-sc-chips";
      document.documentElement.append(bar);
    }
    bar.innerHTML = tokens.map((s) => `<span class="rh-sc-chip" title="${esc(s.content)}">[/${esc(s.trigger)}]</span>`).join("");
    const r = input.getBoundingClientRect();
    bar.style.left = `${Math.round(r.left)}px`;
    bar.style.maxWidth = `${Math.round(r.width)}px`;
    bar.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
    bar.style.display = "flex";
  }

  function removeScChips() {
    $("#rofan-helper-sc-chips")?.remove();
  }

  // ===== NAI 이미지 생성 연동 =====

  const DEFAULT_NAI_INSTRUCTION = [
    "You are a NovelAI prompt engineer. Generate ONE Danbooru-tag prompt line from the character appearance and recent chat context below.",
    "",
    "Rules:",
    "- Use Danbooru tags as base + natural language for specifics (NAI understands both)",
    "- Be extremely specific: not 'dress' but 'white sleeveless dress, frilled layered skirt, corset bodice'. Not 'staff' but 'heart-shaped staff, silver, jeweled topper'.",
    "- Use NAI weighting (1.3::tag ::) for key elements",
    "- NO quality/artist tags (masterpiece, best quality, etc) — 템플릿 프롬프트에 이미 포함되어 있음",
    "- Be extremely detailed using real tags: composition, pose with arm/hand/leg specifics, expression, gaze, hairstyle, outfit (every layer with color), background with location+time+weather, lighting, effects",
    "- Auto-fill anything not specified with contextually appropriate tags",
    "- Start with the character appearance tags, then the current scene from the chat",
    "",
    "KEY VERIFIED TAGS (use these, post count = reliability):",
    "Composition: 1girl(7.5M), solo(6.2M), full body(1.1M), cowboy shot(749K), upper body(1M), from below(105K), dutch angle(146K)",
    "Pose: standing(1.1M), sitting(1.1M), arms behind back(110K), hand on own hip(201K), holding(1.9M), head tilt(161K), leaning forward(145K)",
    "Expression: smile(3.6M), blush(3.6M), half-closed eyes(126K), smirk(33K), parted lips(658K)",
    "Outfit: shirt(2.5M), dress(1.7M), thighhighs(1.4M), gloves(1.7M), off shoulder(305K), pleated skirt(639K)",
    "Background: outdoors(702K), indoors(487K), night(152K), sunset(35K), cherry blossoms(66K), simple background(2.4M)",
    "Effects: sparkle(201K), depth of field(118K), petals(159K), wind(63K), lens flare(46K)",
    "",
    "Output ONLY the comma-separated prompt line. No explanations, no quotes, no markdown, no line breaks."
  ].join("\n");

  // 자연어 계열 이미지 모델(GPT/Gemini/Grok)용 기본 지시문
  const DEFAULT_IMG_INSTRUCTION = [
    "You are an expert illustration prompt writer. Based on the character appearance and the recent chat below, write ONE vivid English image-generation prompt describing the current scene.",
    "- Natural language, 2-4 sentences.",
    "- Include: character appearance, pose, expression, outfit, background (location/time/weather), lighting, mood, composition.",
    "- Anime illustration style unless the chat implies otherwise.",
    "- Output ONLY the prompt text. No quotes, no lists, no markdown."
  ].join("\n");

  function naiConfig() {
    return state.settings.nai || {};
  }

  // 구버전 설정(단일 aiKey/template/pixaiKey)을 새 구조로 이관
  function migrateNaiConfig() {
    const c = state.settings.nai;
    if (!c) return;
    let changed = false;
    if (!c.aiCfg) { c.aiCfg = {}; changed = true; }
    if (c.aiKey && !c.aiCfg[c.aiProvider || "gemini"]) {
      c.aiCfg[c.aiProvider || "gemini"] = { key: c.aiKey, model: c.aiModel || "" };
      changed = true;
    }
    if (!Array.isArray(c.templates)) { c.templates = [null, null, null, null]; changed = true; }
    if (c.template && !c.templates[0]) { c.templates[0] = c.template; changed = true; }
    if (typeof c.activeTemplate !== "number") { c.activeTemplate = 0; changed = true; }
    if (!c.imgCfg) { c.imgCfg = { gpt: { model: "", size: "1024x1536", prompt: "" }, gemini: { model: "", prompt: "" }, grok: { model: "", prompt: "" } }; changed = true; }
    if (!c.instructions) { c.instructions = { nai: c.promptInstruction || "", gpt: "", gemini: "", grok: "" }; changed = true; }
    if (c.imgProvider === "pixai") { c.imgProvider = "nai"; changed = true; } // PixAI 지원 종료
    if (changed) saveState();
  }

  function aiCfgFor(provider) {
    const c = naiConfig();
    return c.aiCfg?.[provider] || { key: c.aiKey || "", model: c.aiModel || "" };
  }

  function activeNaiTemplate() {
    const c = naiConfig();
    return (Array.isArray(c.templates) ? c.templates[c.activeTemplate ?? 0] : null) || c.template || null;
  }

  const IMG_SERVICES = {
    nai: { label: "NovelAI (NAI)" },
    gpt: { provider: "openai", label: "GPT (OpenAI)", def: "gpt-image-1", models: ["gpt-image-1"] },
    gemini: { provider: "gemini", label: "Gemini 나노바나나", def: "gemini-2.5-flash-image", models: ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview"] },
    grok: { provider: "grok", label: "xAI Grok 이미지", def: "grok-2-image", models: ["grok-2-image"] }
  };

  function imgSvc() {
    const v = naiConfig().imgProvider || "nai";
    return IMG_SERVICES[v] ? v : "nai";
  }

  function imgCfgFor(svc) {
    return naiConfig().imgCfg?.[svc] || {};
  }

  // 서비스별 AI 지시문 (비우면 서비스 기본값)
  function instructionFor(svc) {
    const c = naiConfig();
    const saved = c.instructions?.[svc] || (svc === "nai" ? c.promptInstruction : "") || "";
    return saved.trim() || (svc === "nai" ? DEFAULT_NAI_INSTRUCTION : DEFAULT_IMG_INSTRUCTION);
  }

  // 현재 이미지 서비스의 프롬프트 템플릿 (파이프라인 공용 인터페이스)
  function activeImgTemplate() {
    const svc = imgSvc();
    if (svc === "nai") return activeNaiTemplate();
    const cfg = imgCfgFor(svc);
    const prompt = (cfg.prompt || "").trim() || "[[input data]]";
    return { prompt, negative: "", seed: 0, hasPlaceholder: NAI_PLACEHOLDER_RE.test(prompt) };
  }

  function naiReady() {
    const c = naiConfig();
    const ai = aiCfgFor(c.aiProvider);
    const svc = imgSvc();
    const imgOk = svc === "nai"
      ? Boolean(c.naiKey && activeNaiTemplate())
      : Boolean(aiCfgFor(IMG_SERVICES[svc].provider).key);
    return Boolean(c.enabled && imgOk && ai.key);
  }

  // 백그라운드 서비스워커를 통해 외부 API 호출(CORS 우회). 목업에선 직접 fetch.
  function bgFetch(opts) {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        // 응답이 영영 안 오는 경우(SW 중단 등) 대비 타임아웃 — 무한 로딩 방지
        const timer = setTimeout(() => finish({ ok: false, status: 0, error: "응답 시간 초과 (백그라운드)" }), opts.timeoutMs || 30000);
        try {
          chrome.runtime.sendMessage({ type: "rh-fetch", ...opts }, (res) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError?.message || "";
            finish(res || { ok: false, status: 0, error: err || "백그라운드 응답 없음" });
          });
        } catch (e) {
          clearTimeout(timer);
          finish({ ok: false, status: 0, error: String(e?.message || e) });
        }
      });
    }
    // 목업/개발 환경 폴백
    return fetch(opts.url, { method: opts.method || "POST", headers: opts.headers || {}, body: opts.body })
      .then(async (res) => {
        if (opts.responseType === "arraybuffer") {
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return { ok: res.ok, status: res.status, base64: btoa(bin), contentType: res.headers.get("content-type") || "" };
        }
        return { ok: res.ok, status: res.status, text: await res.text() };
      })
      .catch((e) => ({ ok: false, status: 0, error: String(e?.message || e) }));
  }

  // --- PNG 메타데이터(tEXt/iTXt) 파싱: NAI 템플릿 이미지에서 생성 설정 추출 ---
  function parsePngText(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const out = {};
    if (view.getUint32(0) !== 0x89504e47) return out; // PNG 시그니처
    let pos = 8;
    const dec = new TextDecoder("utf-8");
    while (pos + 8 <= bytes.length) {
      const len = view.getUint32(pos);
      const type = dec.decode(bytes.subarray(pos + 4, pos + 8));
      const dataStart = pos + 8;
      if (type === "tEXt") {
        const data = bytes.subarray(dataStart, dataStart + len);
        const nul = data.indexOf(0);
        if (nul > 0) out[dec.decode(data.subarray(0, nul))] = dec.decode(data.subarray(nul + 1));
      } else if (type === "iTXt") {
        const data = bytes.subarray(dataStart, dataStart + len);
        const nul = data.indexOf(0);
        if (nul > 0) {
          // keyword \0 compFlag compMethod \0 lang \0 translated \0 text (비압축만 처리)
          const keyword = dec.decode(data.subarray(0, nul));
          const compFlag = data[nul + 1];
          let p = nul + 3;
          let zero = data.indexOf(0, p); p = zero + 1; // lang
          zero = data.indexOf(0, p); p = zero + 1;     // translated
          if (compFlag === 0) out[keyword] = dec.decode(data.subarray(p));
        }
      } else if (type === "IEND") break;
      pos = dataStart + len + 4;
    }
    return out;
  }

  const NAI_PLACEHOLDER_RE = /\[{2,3}\s*input data\s*\]{2,3}/i;

  // 템플릿 이미지 파일 → NAI 생성 파라미터
  async function extractNaiTemplate(file) {
    const buf = await file.arrayBuffer();
    const text = parsePngText(buf);
    let raw = null;
    try { raw = JSON.parse(text.Comment || "null"); } catch {}
    if (!raw && !text.Description) return null;
    const prompt = String(raw?.prompt ?? text.Description ?? "");
    const source = String(text.Source || "");
    let model = "nai-diffusion-3";
    if (/V4\.?5/i.test(source)) model = "nai-diffusion-4-5-full";
    else if (/V4/i.test(source)) model = "nai-diffusion-4-full";
    return {
      prompt,
      negative: String(raw?.uc ?? raw?.negative_prompt ?? ""),
      model,
      sampler: String(raw?.sampler || "k_euler_ancestral"),
      steps: toNumber(raw?.steps) || 28,
      scale: Number(raw?.scale ?? 5),
      width: toNumber(raw?.width) || 832,
      height: toNumber(raw?.height) || 1216,
      seed: toNumber(raw?.seed) || 0,
      hasPlaceholder: NAI_PLACEHOLDER_RE.test(prompt),
      // raw 메타데이터는 저장하지 않는다 — 요청은 설정값만으로 구성(잔여 필드로 인한 실패 방지)
      source
    };
  }

  // --- 설정 UI (채팅설정 탭 하단) ---
  // [1] 프롬프트 생성 AI 섹션 — 제공사별 키/모델 개별 저장 + 지시문
  function renderPromptAiSettings() {
    const c = naiConfig();
    const ai = aiCfgFor(c.aiProvider);
    return `
      <p class="rh-setting-desc">대화를 분석해 이미지 프롬프트를 만들 AI입니다. 제공사마다 API 키·모델이 <strong>따로 저장</strong>돼 언제든 전환할 수 있어요. (저렴한 모델 권장 — 1회 0.1~2원)</p>
      <label>프롬프트 생성 AI
        <select data-field="nai-provider">
          <option value="gemini" ${c.aiProvider === "gemini" ? "selected" : ""}>Google Gemini (저렴 · 필터 있음)</option>
          <option value="deepseek" ${c.aiProvider === "deepseek" ? "selected" : ""}>DeepSeek (저렴 · 필터 없음)</option>
          <option value="openai" ${c.aiProvider === "openai" ? "selected" : ""}>OpenAI (GPT)</option>
          <option value="grok" ${c.aiProvider === "grok" ? "selected" : ""}>xAI Grok (필터 없음)</option>
          <option value="claude" ${c.aiProvider === "claude" ? "selected" : ""}>Anthropic Claude</option>
        </select>
      </label>
      <label>API 키 <span class="rh-nai-lbl-sub">(${esc(c.aiProvider)} 전용 — 전환해도 각각 보관)</span>
        <input type="password" data-field="nai-aikey" value="${esc(ai.key || "")}" placeholder="${esc(aiKeyPlaceholder(c.aiProvider))}">
      </label>
      <label>모델 (비우면 기본값: ${esc(defaultAiModel(c.aiProvider))})
        <input type="text" data-field="nai-aimodel" list="rh-nai-model-list" value="${esc(ai.model || "")}" placeholder="${esc(defaultAiModel(c.aiProvider))}">
        <datalist id="rh-nai-model-list">
          ${aiModelSuggestions(c.aiProvider).map((m) => `<option value="${esc(m)}"></option>`).join("")}
        </datalist>
      </label>
      <p class="rh-setting-desc" style="margin:2px 0 0">AI 지시문은 <strong>이미지 생성 AI</strong> 섹션에서 서비스별로 설정해요.</p>
      <div class="rh-setting-row">
        <button type="button" class="rh-btn" data-action="nai-save-ai">저장</button>
      </div>
    `;
  }

  // [2] 이미지 생성 AI 섹션 — 서비스별(NAI/GPT/Gemini/Grok) 설정 개별 저장
  function renderImageGenSettings() {
    const c = naiConfig();
    return `
      <label class="rh-check">
        <input type="checkbox" data-field="nai-enabled" ${c.enabled ? "checked" : ""}>
        이미지 생성 기능 사용 <span class="rh-nai-lbl-sub">(대화의 ✦ 버튼)</span>
      </label>
      <label>이미지 생성 서비스 <span class="rh-nai-lbl-sub">(서비스마다 설정·지시문 따로 저장)</span>
        <select data-field="nai-imgprovider">
          ${Object.entries(IMG_SERVICES).map(([v, d]) => `<option value="${v}" ${imgSvc() === v ? "selected" : ""}>${esc(d.label)}</option>`).join("")}
        </select>
      </label>
      ${imgSvc() === "nai" ? renderNaiServiceSettings() : renderSimpleImgSettings(imgSvc())}
      <label style="margin-top:10px">AI 프롬프트 지시문 (${esc(IMG_SERVICES[imgSvc()].label)} 전용) <span class="rh-nai-lbl-sub">— 지시문 아래에 구도(1/2인) 규칙 · 캐릭터 외형 · 페르소나 외형 · 최근 대화가 자동으로 붙어요</span>
        <textarea data-field="img-instruction" class="rh-nai-instruction">${esc(instructionFor(imgSvc()))}</textarea>
      </label>
      <div class="rh-setting-row">
        <button type="button" class="rh-btn rh-btn-ghost rh-btn-sm" data-action="nai-instruction-reset">지시문 기본값 복원</button>
        <p class="rh-setting-count" style="flex:1">${naiReady() ? "설정 완료 — 대화의 ✦ 버튼으로 생성" : "키·설정을 채우면 사용 가능"}</p>
        ${imgSvc() === "nai" ? `<button type="button" class="rh-btn rh-btn-ghost" data-action="nai-test">NAI 연결 테스트</button>` : ""}
        <button type="button" class="rh-btn" data-action="nai-save-img">저장</button>
      </div>
    `;
  }

  // GPT/Gemini/Grok 이미지 서비스 설정 (키는 프롬프트 생성 AI와 공유)
  function renderSimpleImgSettings(svc) {
    const d = IMG_SERVICES[svc];
    const cfg = imgCfgFor(svc);
    const key = aiCfgFor(d.provider).key || "";
    return `
      <label>API 키 <span class="rh-nai-lbl-sub">(프롬프트 생성 AI의 ${esc(d.provider)} 키와 공유 — 이미 있으면 자동 연결)</span>
        <input type="password" data-field="img-key" value="${esc(key)}" placeholder="${esc(aiKeyPlaceholder(d.provider))}">
      </label>
      <label>이미지 모델 (비우면 기본값: ${esc(d.def)})
        <input type="text" data-field="img-model" list="rh-img-model-list" value="${esc(cfg.model || "")}" placeholder="${esc(d.def)}">
        <datalist id="rh-img-model-list">${d.models.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>
      </label>
      ${svc === "gpt" ? `
      <label>이미지 크기
        <select data-field="img-size">
          ${["1024x1024", "1024x1536", "1536x1024"].map((v) => `<option value="${v}" ${(cfg.size || "1024x1536") === v ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </label>` : ""}
      <label>프롬프트 템플릿 <span class="rh-nai-lbl-sub">— [[input data]] 자리에 AI 프롬프트가 들어가요 (없으면 저장 시 자동 추가, 비우면 AI 프롬프트만 사용)</span>
        <textarea data-field="img-prompt" placeholder="예: anime illustration, [[input data]], soft lighting">${esc(cfg.prompt || "")}</textarea>
      </label>
      <p class="rh-setting-desc" style="margin:2px 0 0">1장당 예상 비용: ${svc === "gpt" ? "약 $0.04~0.25 (크기·품질에 따라 ≈ 60~360원)" : svc === "gemini" ? "약 $0.04 (≈ 55~60원)" : "약 $0.07 (≈ 100원)"} — 생성 후 실제 비용이 결과 창에 표시돼요.</p>
    `;
  }

  // NAI 서비스 설정 (키 + 그림체 1~4 템플릿)
  function renderNaiServiceSettings() {
    const c = naiConfig();
    const idx = c.activeTemplate ?? 0;
    const t = activeNaiTemplate();
    const slots = [0, 1, 2, 3];
    return `
      <label>NAI API 키 (persistent token)
        <input type="password" data-field="nai-naikey" value="${esc(c.naiKey || "")}" placeholder="pst-...">
      </label>
      <p class="rh-nai-tpl-head" style="margin-top:6px">그림체 (템플릿 슬롯)</p>
      <div class="rh-seg">
        ${slots.map((i) => `<button type="button" class="rh-seg-btn${idx === i ? " active" : ""}" data-action="nai-style-slot" data-slot="${i}">그림체${i + 1}${(c.templates || [])[i] ? "" : "<br><small>(비어있음)</small>"}</button>`).join("")}
      </div>
      <label>템플릿 이미지 업로드 → <strong>그림체${idx + 1}</strong>에 저장 <span class="rh-nai-lbl-sub">(NAI 원본 PNG, 프롬프트에 [[input data]] 자리 권장)</span>
        <input type="file" accept="image/png" data-field="nai-template-file">
      </label>
      ${t ? `
        <div class="rh-nai-template">
          <p class="rh-nai-tpl-head">그림체${idx + 1} 설정 ${t.hasPlaceholder ? `<span class="rh-nai-ok">[[input data]] 자리 확인됨</span>` : `<span class="rh-nai-warn">자리표시 없음 — 저장 시 자동 추가</span>`}</p>
          <label>프롬프트<textarea data-field="nai-t-prompt">${esc(t.prompt || "")}</textarea></label>
          <label>네거티브<textarea data-field="nai-t-negative">${esc(t.negative || "")}</textarea></label>
          <div class="rh-nai-grid">
            <label>모델<input type="text" data-field="nai-t-model" value="${esc(t.model)}"></label>
            <label>샘플러<input type="text" data-field="nai-t-sampler" value="${esc(t.sampler)}"></label>
            <label>스텝<input type="number" data-field="nai-t-steps" value="${esc(String(t.steps))}"></label>
            <label>스케일<input type="number" step="0.1" data-field="nai-t-scale" value="${esc(String(t.scale))}"></label>
            <label>가로<input type="number" data-field="nai-t-width" value="${esc(String(t.width))}"></label>
            <label>세로<input type="number" data-field="nai-t-height" value="${esc(String(t.height))}"></label>
          </div>
          <label class="rh-check">
            <input type="checkbox" data-field="nai-seed-locked" ${c.seedLocked ? "checked" : ""}>
            시드 고정 (<span class="rh-nai-seed">${esc(String(t.seed || 0))}</span>) — 끄면 매번 무작위
          </label>
        </div>` : `<p class="rh-setting-desc">그림체${idx + 1}이 비어 있어요 — 템플릿 이미지를 업로드해 주세요.</p>`}
    `;
  }


  function defaultAiModel(provider) {
    if (provider === "deepseek") return "deepseek-chat";
    if (provider === "openai") return "gpt-4o-mini";
    if (provider === "grok") return "grok-3-mini";
    if (provider === "claude") return "claude-haiku-4-5";
    return "gemini-2.0-flash";
  }

  function aiModelSuggestions(provider) {
    if (provider === "deepseek") return ["deepseek-chat", "deepseek-reasoner"];
    if (provider === "openai") return ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4.1"];
    if (provider === "grok") return ["grok-3-mini", "grok-3", "grok-4"];
    if (provider === "claude") return ["claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-sonnet-4-5"];
    return ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"];
  }

  function aiKeyPlaceholder(provider) {
    if (provider === "gemini") return "AIza...";
    if (provider === "grok") return "xai-...";
    if (provider === "claude") return "sk-ant-...";
    return "sk-...";
  }

  // 모델별 가격 (USD / 100만 토큰, [입력, 출력]) — 대략치
  const AI_PRICES = {
    "gemini-2.0-flash": [0.10, 0.40],
    "gemini-2.5-flash-lite": [0.10, 0.40],
    "gemini-2.5-flash": [0.30, 2.50],
    "gemini-2.5-pro": [1.25, 10],
    "deepseek-chat": [0.27, 1.10],
    "deepseek-reasoner": [0.55, 2.19],
    "gpt-4o-mini": [0.15, 0.60],
    "gpt-4.1-mini": [0.40, 1.60],
    "gpt-4.1-nano": [0.10, 0.40],
    "gpt-4o": [2.50, 10],
    "gpt-4.1": [2, 8],
    "grok-3-mini": [0.30, 0.50],
    "grok-3": [3, 15],
    "grok-4": [3, 15],
    "claude-haiku-4-5": [1, 5],
    "claude-3-5-haiku": [0.80, 4],
    "claude-sonnet-4-5": [3, 15]
  };

  // USD→KRW 환율 (12시간 캐시, 실패 시 1450 폴백)
  async function getUsdKrw() {
    const cached = state.settings.nai?.usdKrw;
    if (cached?.rate && Date.now() - (cached.at || 0) < 12 * 3600 * 1000) return cached.rate;
    try {
      const res = await bgFetch({ url: "https://open.er-api.com/v6/latest/USD", method: "GET" });
      const rate = res.ok ? Number(JSON.parse(res.text)?.rates?.KRW) : 0;
      if (rate > 0) {
        state.settings.nai = { ...naiConfig(), usdKrw: { rate, at: Date.now() } };
        await saveState();
        return rate;
      }
    } catch {}
    return cached?.rate || 1450;
  }

  function aiCostKrw(model, usage, rate) {
    if (!usage) return null;
    const key = Object.keys(AI_PRICES).find((k) => String(model || "").startsWith(k));
    if (!key) return null;
    const [pin, pout] = AI_PRICES[key];
    return ((usage.input || 0) * pin + (usage.output || 0) * pout) / 1e6 * rate;
  }

  function usageLine(entry) {
    const parts = [];
    const u = entry.aiUsage;
    if (u && (u.input || u.output)) {
      const total = (u.input || 0) + (u.output || 0);
      parts.push(`AI ${total.toLocaleString()}토큰${entry.aiCostKrw != null ? ` 약 ${entry.aiCostKrw.toFixed(1)}원` : ""}`);
    }
    if (entry.imgCostKrw != null) parts.push(`이미지 약 ${entry.imgCostKrw.toFixed(1)}원`);
    if (entry.aiCostKrw != null && entry.imgCostKrw != null) parts.push(`합계 약 ${(entry.aiCostKrw + entry.imgCostKrw).toFixed(1)}원`);
    return parts.length ? parts.join(" · ") + " · " : "";
  }

  // --- AI 프롬프트 생성 ---
  async function callAiPrompt(instructionText) {
    const c = naiConfig();
    const ai = aiCfgFor(c.aiProvider);
    const model = ai.model || defaultAiModel(c.aiProvider);
    let res;
    if (c.aiProvider === "gemini") {
      res = await bgFetch({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ai.key)}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: instructionText }] }],
          // 안전 필터 최대 완화 — SAFETY 계열 차단을 줄인다.
          // (PROHIBITED_CONTENT는 설정으로 해제 불가한 핵심 필터라 여전히 걸릴 수 있음)
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
        })
      });
      if (!res.ok) throw new Error(`AI 호출 실패 (${res.status}) ${res.error || res.text?.slice(0, 200) || ""}`);
      const data = JSON.parse(res.text);
      const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      if (!text) {
        // Gemini가 안전 필터로 차단하면 빈 응답이 온다 — 사유를 그대로 보여준다
        const block = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "";
        if (block && block !== "STOP") {
          const hard = block === "PROHIBITED_CONTENT";
          throw new Error(hard
            ? `Gemini가 응답을 차단했어요 (${block}). 이 차단은 안전 설정으로도 해제할 수 없는 Gemini 핵심 필터예요 — 이 장면은 채팅설정에서 프롬프트 생성 AI를 DeepSeek이나 Grok으로 바꿔 생성해 주세요.`
            : `Gemini가 응답을 차단했어요 (${block}). 안전 필터를 최대 완화해 두었지만 걸렸어요 — 이 장면은 DeepSeek이나 Grok으로 바꿔 생성해 주세요.`);
        }
      }
      return {
        text,
        usage: { input: toNumber(data?.usageMetadata?.promptTokenCount), output: toNumber(data?.usageMetadata?.candidatesTokenCount) }
      };
    }
    if (c.aiProvider === "claude") {
      res = await bgFetch({
        url: "https://api.anthropic.com/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ai.key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content: instructionText }] })
      });
      if (!res.ok) throw new Error(`AI 호출 실패 (${res.status}) ${res.error || res.text?.slice(0, 200) || ""}`);
      const data = JSON.parse(res.text);
      return {
        text: (data?.content || []).filter((p) => p.type === "text").map((p) => p.text).join("").trim(),
        usage: { input: toNumber(data?.usage?.input_tokens), output: toNumber(data?.usage?.output_tokens) }
      };
    }
    // OpenAI 호환 계열: deepseek / openai / grok
    const base = c.aiProvider === "deepseek" ? "https://api.deepseek.com"
      : c.aiProvider === "grok" ? "https://api.x.ai/v1"
      : "https://api.openai.com/v1";
    res = await bgFetch({
      url: `${base}/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: instructionText }] })
    });
    if (!res.ok) throw new Error(`AI 호출 실패 (${res.status}) ${res.error || res.text?.slice(0, 200) || ""}`);
    const data = JSON.parse(res.text);
    return {
      text: String(data?.choices?.[0]?.message?.content || "").trim(),
      usage: { input: toNumber(data?.usage?.prompt_tokens), output: toNumber(data?.usage?.completion_tokens) }
    };
  }

  function cleanAiPrompt(text) {
    return String(text || "")
      .replace(/```[a-z]*\n?|```/g, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/\n+/g, ", ")
      .slice(0, 2000);
  }

  // --- NAI 이미지 생성 ---
  // 요청은 템플릿 메타데이터(raw)를 일절 쓰지 않고, 설정 화면에 보이는 값만으로 깨끗하게 구성한다.
  // (메타데이터 잔여 필드 — 참조 이미지, 캐릭터 좌표, 서명 등 — 가 전송 실패를 유발했음)
  function buildNaiRequest(finalPrompt, seed) {
    const t = activeNaiTemplate();
    const model = t.model || "nai-diffusion-3";
    const negative = t.negative || "";
    const isV4 = /diffusion-4/.test(model);
    const params = {
      params_version: isV4 ? 3 : 1,
      width: toNumber(t.width) || 832,
      height: toNumber(t.height) || 1216,
      scale: Number(t.scale ?? 5),
      sampler: t.sampler || "k_euler_ancestral",
      steps: toNumber(t.steps) || 28,
      seed,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      cfg_rescale: 0,
      negative_prompt: negative
    };
    if (isV4) {
      // 공식 웹과 동일한 필드 구성 (누락 필드가 500을 유발할 수 있음)
      params.noise_schedule = "karras";
      params.autoSmea = false;
      params.legacy_v3_extend = false;
      params.skip_cfg_above_sigma = null;
      params.use_coords = false;
      params.legacy_uc = false;
      params.normalize_reference_strength_multiple = true;
      params.inpaintImg2ImgStrength = 1;
      params.characterPrompts = [];
      params.v4_prompt = { caption: { base_caption: finalPrompt, char_captions: [] }, use_coords: false, use_order: true };
      params.v4_negative_prompt = { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false };
      params.deliberate_euler_ancestral_bug = false;
      params.prefer_brownian = true;
    } else {
      params.noise_schedule = "native";
      params.sm = false;
      params.sm_dyn = false;
      params.uc = negative;
    }
    return { input: finalPrompt, model, action: "generate", parameters: params };
  }

  function decodeBase64Utf8(base64) {
    try {
      const bin = atob(base64 || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return "";
    }
  }

  // --- GPT/Gemini/Grok 이미지 생성 ---
  async function callGptImage(finalPrompt) {
    const key = aiCfgFor("openai").key;
    if (!key) throw new Error("OpenAI API 키가 비어 있어요. (프롬프트 생성 AI와 공유)");
    const cfg = imgCfgFor("gpt");
    const res = await bgFetch({
      url: "https://api.openai.com/v1/images/generations",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model || "gpt-image-1", prompt: finalPrompt, size: cfg.size || "1024x1536", n: 1 })
    });
    if (!res.ok) {
      let msg = res.error || res.text?.slice(0, 250) || "";
      try { msg = JSON.parse(res.text).error?.message || msg; } catch {}
      throw new Error(`GPT 이미지 생성 실패 (${res.status}) ${msg}`);
    }
    const data = JSON.parse(res.text);
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error("GPT 응답에 이미지가 없어요.");
    // 비용: usage 토큰 기반(텍스트입력 $5/1M, 이미지출력 $40/1M), 없으면 크기 기준 추정
    let costUsd = null;
    const u = data?.usage;
    if (u) costUsd = (toNumber(u.input_tokens) * 5 + toNumber(u.output_tokens) * 40) / 1e6;
    else costUsd = ({ "1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063 })[cfg.size || "1024x1536"] ?? 0.06;
    return { dataUrl: `data:image/png;base64,${b64}`, costUsd };
  }

  async function callGeminiImage(finalPrompt) {
    const key = aiCfgFor("gemini").key;
    if (!key) throw new Error("Gemini API 키가 비어 있어요. (프롬프트 생성 AI와 공유)");
    const cfg = imgCfgFor("gemini");
    const model = cfg.model || "gemini-2.5-flash-image";
    const res = await bgFetch({
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: finalPrompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ]
      })
    });
    if (!res.ok) {
      let msg = res.error || res.text?.slice(0, 250) || "";
      try { msg = JSON.parse(res.text).error?.message || msg; } catch {}
      throw new Error(`Gemini 이미지 생성 실패 (${res.status}) ${msg}`);
    }
    const data = JSON.parse(res.text);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const img = parts.find((x) => x.inlineData?.data);
    if (!img) {
      const block = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "";
      throw new Error(block && block !== "STOP"
        ? `Gemini가 이미지 생성을 차단했어요 (${block}). 이 장면은 GPT/NAI로 생성해 보세요.`
        : "Gemini 응답에 이미지가 없어요.");
    }
    // 비용: 출력(이미지) 토큰 $30/1M + 입력 $0.30/1M, 없으면 1장 ≈ $0.039
    const um = data?.usageMetadata;
    const costUsd = um
      ? (toNumber(um.promptTokenCount) * 0.30 + toNumber(um.candidatesTokenCount) * 30) / 1e6
      : 0.039;
    return { dataUrl: `data:${img.inlineData.mimeType || "image/png"};base64,${img.inlineData.data}`, costUsd };
  }

  async function callGrokImage(finalPrompt) {
    const key = aiCfgFor("grok").key;
    if (!key) throw new Error("Grok API 키가 비어 있어요. (프롬프트 생성 AI와 공유)");
    const cfg = imgCfgFor("grok");
    const res = await bgFetch({
      url: "https://api.x.ai/v1/images/generations",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.model || "grok-2-image", prompt: finalPrompt, response_format: "b64_json", n: 1 })
    });
    if (!res.ok) {
      let msg = res.error || res.text?.slice(0, 250) || "";
      try { msg = JSON.parse(res.text).error || JSON.parse(res.text).error?.message || msg; } catch {}
      throw new Error(`Grok 이미지 생성 실패 (${res.status}) ${typeof msg === "string" ? msg : JSON.stringify(msg).slice(0, 200)}`);
    }
    const b64 = JSON.parse(res.text)?.data?.[0]?.b64_json;
    if (!b64) throw new Error("Grok 응답에 이미지가 없어요.");
    return { dataUrl: `data:image/png;base64,${b64}`, costUsd: 0.07 }; // 정액 $0.07/장
  }

  async function callNaiGenerate(finalPrompt, seed) {
    const c = naiConfig();
    const request = buildNaiRequest(finalPrompt, seed);
    const post = (host) => bgFetch({
      url: `${host}/ai/generate-image`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.naiKey}` },
      body: JSON.stringify(request),
      responseType: "arraybuffer"
    });
    let res = await post("https://image.novelai.net");
    // 연결 자체가 실패(status 0)하면 예비 도메인으로 재시도
    if (res.status === 0) {
      console.warn("[Rofan Helper] image.novelai.net 연결 실패 — api.novelai.net으로 재시도", res.error);
      res = await post("https://api.novelai.net");
    }
    if (!res.ok) {
      // 에러 본문(JSON)의 message를 해독해 보여준다 + 요청 내용을 콘솔에 남긴다
      let detail = res.error || "";
      const bodyText = decodeBase64Utf8(res.base64);
      if (bodyText) {
        try { detail = JSON.parse(bodyText).message || bodyText.slice(0, 300); }
        catch { detail = bodyText.slice(0, 300); }
      }
      if (res.status === 0) {
        detail = `NAI 서버에 연결하지 못했어요 (${detail || "Failed to fetch"}). 네트워크/DNS 차단일 수 있어요 — 채팅설정의 [NAI 연결 테스트]로 확인하고, 브라우저 '보안 DNS(DoH)'를 켜거나 VPN을 써보세요.`;
      }
      console.warn("[Rofan Helper] NAI 요청 실패", res.status, detail, request);
      throw new Error(`NAI 호출 실패 (${res.status}) ${detail}`);
    }
    return extractImageFromResponse(res.base64, res.contentType);
  }

  // NAI 연결 진단: 두 도메인 도달성 + API 키 인증을 순서대로 점검
  async function testNaiConnection() {
    const c = naiConfig();
    closeNaiModal();
    const modal = openNaiModal(`
      <div class="rh-import-spinner"></div>
      <h3 class="rh-import-title">NAI 연결 테스트 중…</h3>
    `);
    const lines = [];
    const ping = async (label, url) => {
      const r = await bgFetch({ url, method: "GET", timeoutMs: 10000 });
      const ok = r.status > 0;
      lines.push(`${ok ? "✅" : "❌"} ${label}: ${ok ? `연결됨 (HTTP ${r.status})` : `연결 실패 — ${r.error || "Failed to fetch"}`}`);
      return ok;
    };
    const img = await ping("image.novelai.net (이미지 생성 서버)", "https://image.novelai.net/");
    const api = await ping("api.novelai.net (예비/계정 서버)", "https://api.novelai.net/");
    if (c.naiKey && (img || api)) {
      // 인증 점검도 이미지 서버로 — api.novelai.net은 "update to the image URL" 400으로 게이트됨
      let r = await bgFetch({ url: "https://image.novelai.net/user/subscription", method: "GET", headers: { Authorization: `Bearer ${c.naiKey}` } });
      if (r.status === 0) r = await bgFetch({ url: "https://api.novelai.net/user/subscription", method: "GET", headers: { Authorization: `Bearer ${c.naiKey}` } });
      if (r.status === 200) {
        let extra = "";
        try {
          const d = JSON.parse(r.text);
          const tier = ["Paper", "Tablet", "Scroll", "Opus"][toNumber(d.tier)] || `tier ${d.tier}`;
          const anlas = toNumber(d?.trainingStepsLeft?.fixedTrainingStepsLeft) + toNumber(d?.trainingStepsLeft?.purchasedTrainingSteps);
          extra = ` — ${tier}, Anlas ${anlas.toLocaleString()}`;
        } catch {}
        lines.push(`✅ API 키 인증: 정상${extra}`);
      } else {
        lines.push(`❌ API 키 인증: HTTP ${r.status} ${r.text ? r.text.slice(0, 120) : r.error || ""}`);
      }
    } else if (!c.naiKey) {
      lines.push("⚠️ NAI API 키가 비어 있어 인증 확인은 건너뜀");
    }
    let advice = "";
    if (!img && !api) advice = "두 서버 모두 연결 실패 → 네트워크/DNS 차단 가능성이 큽니다. 브라우저 설정에서 '보안 DNS(DNS-over-HTTPS)'를 켜거나(예: Cloudflare 1.1.1.1), VPN 사용을 시도해 보세요.";
    else if (!img && api) advice = "이미지 서버만 막혀 있어요. 생성 시 자동으로 예비 서버(api.novelai.net)로 재시도합니다.";
    modal.innerHTML = `
      <div class="rh-import-card rh-nai-card">
        <h3 class="rh-import-title">NAI 연결 테스트 결과</h3>
        <div class="rh-nai-test-lines">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>
        ${advice ? `<p class="rh-setting-warn" style="display:block">${esc(advice)}</p>` : ""}
        <div class="rh-nai-modal-actions"><button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">닫기</button></div>
      </div>`;
    modal.addEventListener("click", (e) => { if (e.target.closest("[data-nai-modal='close']") || e.target === modal) closeNaiModal(); });
  }

  // NAI 응답(zip 또는 png) → PNG dataURL
  async function extractImageFromResponse(base64, contentType) {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      return `data:image/png;base64,${base64}`; // PNG 직접 응답
    }
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`알 수 없는 NAI 응답 형식 (${contentType || "?"})`);
    try {
      const { method, data } = extractFirstZipEntry(bytes);
      let fileBytes = data;
      if (method === 8) {
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([fileBytes]).stream().pipeThrough(ds);
        fileBytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } else if (method !== 0) {
        throw new Error(`지원하지 않는 압축 방식 (${method})`);
      }
      const blob = new Blob([fileBytes], { type: "image/png" });
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      // 스트림 에러가 원인 없는 TypeError("Failed to fetch")로 보이지 않게 감싼다
      throw new Error(`NAI 응답(zip) 해제 실패: ${String(error?.message || error)}`);
    }
  }

  // ZIP의 첫 파일 엔트리를 정확한 크기로 추출.
  // NAI는 스트리밍 zip(로컬 헤더 크기 0, 실제 크기는 central directory에만 기록)을 보낼 수 있어,
  // 로컬 헤더만 믿으면 뒤쪽 바이트까지 섞여 해제가 실패한다 → EOCD → central directory에서 읽는다.
  function extractFirstZipEntry(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let method;
    let compSize;
    let localOff;
    // EOCD(0x06054b50)를 끝에서부터 탐색 (zip 주석 최대 64KB 감안)
    let eocd = -1;
    const min = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd >= 0) {
      const cdOff = view.getUint32(eocd + 16, true);
      if (bytes[cdOff] === 0x50 && bytes[cdOff + 1] === 0x4b && bytes[cdOff + 2] === 0x01 && bytes[cdOff + 3] === 0x02) {
        method = view.getUint16(cdOff + 10, true);
        compSize = view.getUint32(cdOff + 20, true);
        localOff = view.getUint32(cdOff + 42, true);
      }
    }
    if (localOff === undefined) {
      // central directory를 못 찾으면 로컬 헤더 폴백
      localOff = 0;
      method = view.getUint16(8, true);
      compSize = view.getUint32(18, true);
    }
    const nameLen = view.getUint16(localOff + 26, true);
    const extraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + nameLen + extraLen;
    const data = bytes.subarray(start, compSize > 0 ? start + compSize : undefined);
    return { method, data };
  }

  // dataURL 이미지 축소(JPEG) — 저장 용량 관리용
  function downscaleImage(dataUrl, maxSide, quality = 0.88) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // --- 채팅 페이지: 고정 버튼 감지 + 이미지 도구 / 메시지별 생성 버튼 ---
  function findPinButton() {
    return $$("button").find((b) => b.classList.contains("bg-yellow-500") && b.querySelector("svg path[stroke-linecap]") && !isHelperElement(b));
  }

  function findRoomImageEl() {
    return $("img[alt='PC Character Image']")
      || $$("img.object-cover").filter((el) => !isHelperElement(el) && el.getBoundingClientRect().width > 200 && el.getBoundingClientRect().left < window.innerWidth * 0.55)[0]
      || null;
  }

  function chatRoomId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : "";
  }

  function enhanceNaiChatTools() {
    if (!/\/chat\//.test(location.pathname)) {
      $("#rofan-helper-img-tools")?.remove();
      return;
    }
    applyRoomCustomImage();
    // [1] 고정 상태일 때만 도구 버튼 표시
    const pin = findPinButton();
    let tools = $("#rofan-helper-img-tools");
    if (!pin) { tools?.remove(); }
    else {
      const hostParent = pin.parentElement;
      if (!tools || tools.parentElement !== hostParent) {
        tools?.remove();
        tools = document.createElement("div");
        tools.id = "rofan-helper-img-tools";
        tools.innerHTML = `<button type="button" data-rh-img-action="change">이미지 변경</button>`;
        tools.addEventListener("click", onImgToolClick);
        if (getComputedStyle(hostParent).position === "static") hostParent.style.position = "relative";
        hostParent.append(tools);
      }
    }
    // [3] 메시지별 '이미지 생성' 버튼 (NAI 준비된 경우)
    if (naiReady()) injectMessageGenButtons();
    else $$(".rh-nai-msg-btn").forEach((b) => b.remove());
  }

  async function onImgToolClick(event) {
    const btn = event.target.closest("[data-rh-img-action]");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    if (btn.dataset.rhImgAction === "change") showImageChangeMenu();
  }

  function showImageChangeMenu() {
    const roomId = chatRoomId();
    const room = state.rooms[roomId] || {};
    closeNaiModal();
    const modal = openNaiModal(`
      <h3 class="rh-import-title">대화방 이미지 변경</h3>
      <p class="rh-setting-desc">고정된 대화방 이미지를 내 이미지(로컬)로 바꿔 보여줍니다. 새로고침해도 유지돼요. (내 화면에서만 보임)</p>
      <div class="rh-nai-modal-actions">
        <button type="button" class="rh-btn" data-nai-modal="pick-image">이미지 선택…</button>
        ${room.customImage ? `<button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="reset-image">원래 이미지로</button>` : ""}
        <button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">닫기</button>
      </div>
    `);
    modal.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-nai-modal]");
      if (!b) return;
      if (b.dataset.naiModal === "close") closeNaiModal();
      if (b.dataset.naiModal === "reset-image") {
        ensureRoom(roomId, { customImage: null });
        await saveState();
        applyRoomCustomImage(true);
        closeNaiModal();
        showToast("원래 이미지로 되돌렸어요.");
      }
      if (b.dataset.naiModal === "pick-image") {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/*";
        inp.addEventListener("change", async () => {
          const file = inp.files?.[0];
          if (!file) return;
          const dataUrl = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
          const sized = await downscaleImage(dataUrl, 1400, 0.9);
          ensureRoom(roomId, { customImage: sized });
          await saveState();
          applyRoomCustomImage();
          closeNaiModal();
          showToast("대화방 이미지를 변경했어요.");
        });
        inp.click();
      }
    });
  }

  // [2] 저장된 커스텀 이미지를 대화방 이미지에 적용(원본은 dataset에 보관)
  // 교체 대상 수집: 넓은 화면의 <img>뿐 아니라, 좁은 화면에서 이미지가
  // 배경(background-image)이나 모바일용 <img>로 렌더되는 경우까지 모두 잡는다.
  function findRoomImageTargets() {
    const targets = [];
    $$("img").forEach((el) => {
      if (isHelperElement(el)) return;
      const alt = el.getAttribute("alt") || "";
      const src = el.currentSrc || el.src || "";
      if (/character image/i.test(alt)
        || el.dataset.rhOrigSrc // 이미 교체된 요소(복원 대상)
        || (/bot-assets/i.test(src) && el.getBoundingClientRect().width > 120)) {
        targets.push({ el, type: "img" });
      }
    });
    if (!targets.length) {
      const img = findRoomImageEl();
      if (img) targets.push({ el: img, type: "img" });
    }
    $$("[style*='background-image']").forEach((el) => {
      if (isHelperElement(el)) return;
      const bg = el.style.backgroundImage || "";
      // 방 이미지를 배경으로 쓰는 요소(좁은 화면) 또는 이미 교체된 요소(복원 대상)
      if (/bot-assets|img\.rofan\.ai/i.test(bg) || el.dataset.rhOrigBg) {
        targets.push({ el, type: "bg" });
      }
    });
    return targets;
  }

  function applyRoomCustomImage(forceRestore) {
    const roomId = chatRoomId();
    if (!roomId) return;
    const custom = state.rooms[roomId]?.customImage;
    findRoomImageTargets().forEach(({ el, type }) => {
      if (type === "img") {
        if (custom && !forceRestore) {
          if (el.src !== custom) {
            if (!el.dataset.rhOrigSrc) el.dataset.rhOrigSrc = el.src;
            el.src = custom;
            el.srcset = "";
          }
        } else if (el.dataset.rhOrigSrc) {
          el.src = el.dataset.rhOrigSrc;
          delete el.dataset.rhOrigSrc;
        }
      } else {
        const want = custom ? `url("${custom}")` : "";
        if (custom && !forceRestore) {
          if (el.style.backgroundImage !== want) {
            if (!el.dataset.rhOrigBg) el.dataset.rhOrigBg = el.style.backgroundImage;
            el.style.backgroundImage = want;
          }
        } else if (el.dataset.rhOrigBg) {
          el.style.backgroundImage = el.dataset.rhOrigBg;
          delete el.dataset.rhOrigBg;
        }
      }
    });
  }

  // 메시지 행 수집: 사이트의 메시지 액션 버튼 줄(북마크 등)이 있는 블록
  function collectMessageRows() {
    return $$(".flex.justify-end.items-center.gap-x-3").filter((row) =>
      !isHelperElement(row) && row.querySelector("button svg") && !row.closest("#rofan-helper-panel"));
  }

  function messageContainerOf(row) {
    return row.closest(".mt-5") || row.parentElement?.parentElement || row.parentElement;
  }

  function messageTextOf(row) {
    const cont = messageContainerOf(row);
    const textDiv = cont && $$("div[style*='font-size']", cont).pop();
    return compactText((textDiv || cont)?.innerText || "", 1200);
  }

  function compactText(text, max) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  function msgKeyOf(roomId, text) {
    let h = 5381;
    const s = roomId + "|" + text.slice(0, 200);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return String(h);
  }

  function injectMessageGenButtons() {
    collectMessageRows().forEach((row) => {
      const inner = row.querySelectorAll(".flex.justify-end.items-center.gap-x-3");
      const target = inner.length ? inner[inner.length - 1] : row;
      let btn = target.querySelector(".rh-nai-msg-btn");
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rh-nai-msg-btn";
        btn.title = "이미지 생성 (NAI)";
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" class="rh-nai-msg-ic"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          startNaiGeneration(row);
        });
        target.append(btn);
      }
      // 이 메시지에 생성 이력이 있으면 금색 표시(기존 버튼도 갱신)
      const key = msgKeyOf(chatRoomId(), messageTextOf(row));
      btn.classList.toggle("rh-nai-has-gen", (state.naiHistory || []).some((h) => h.msgKey === key));
    });
  }

  // --- 생성 파이프라인 ---
  function naiCharInfo() {
    const roomId = chatRoomId();
    const room = state.rooms[roomId] || {};
    const charId = room.characterId || "";
    const appearance = (charId && state.characters[charId]?.appearance) || room.naiCharAppearance || "";
    return { roomId, charId, appearance, persona: room.naiPersona || "" };
  }

  async function saveNaiCharInfo(charText, personaText) {
    const { roomId, charId } = naiCharInfo();
    if (charId) ensureCharacter(charId, { appearance: charText });
    ensureRoom(roomId, { naiCharAppearance: charText, naiPersona: personaText || null });
    await saveState();
  }

  // "이 채팅에서 페르소나 안내 다시 보지 않기" — 세션 한정(새로고침/재입장 시 리셋)
  const naiPersonaNoticeSkip = new Set();

  async function startNaiGeneration(row) {
    const info = naiCharInfo();
    const text = messageTextOf(row);
    const key = msgKeyOf(info.roomId, text);
    const existing = (state.naiHistory || []).filter((h) => h.msgKey === key);
    if (existing.length) {
      showNaiResultModal(existing[existing.length - 1], row);
      return;
    }
    if (!info.appearance) {
      showAppearanceModal(() => startNaiGeneration(row));
      return;
    }
    // 캐릭터 외형은 있는데(다른 방에서 등록됨) 페르소나가 없는 방:
    // 바로 AI를 부르지 않고 1인 생성 안내 + 페르소나 등록 기회를 준다.
    if (!info.persona && !naiPersonaNoticeSkip.has(info.roomId)) {
      showPersonaNoticeModal(row, info.roomId);
      return;
    }
    await runNaiPipeline(row, null);
  }

  function showPersonaNoticeModal(row, roomId) {
    closeNaiModal();
    const modal = openNaiModal(`
      <h3 class="rh-import-title">페르소나 외형 미등록</h3>
      <p class="rh-setting-desc">현재 페르소나 외형이 등록되지 않았습니다.<br>이 경우 <strong>캐릭터 위주의 1인 그림</strong>이 생성됩니다.</p>
      <label class="rh-check">
        <input type="checkbox" data-nai-field="skip-notice">
        현재 채팅중에는 더 이상 보지 않기
      </label>
      <div class="rh-nai-modal-actions">
        <button type="button" class="rh-btn" data-nai-modal="persona-register">페르소나 등록하기</button>
        <button type="button" class="rh-btn" data-nai-modal="persona-continue">1인 그림으로 계속</button>
        <button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">취소</button>
      </div>
    `);
    modal.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-nai-modal]");
      if (!b) return;
      const skip = modal.querySelector("[data-nai-field='skip-notice']")?.checked;
      if (skip) naiPersonaNoticeSkip.add(roomId);
      if (b.dataset.naiModal === "close") closeNaiModal();
      if (b.dataset.naiModal === "persona-register") {
        showAppearanceModal(() => startNaiGeneration(row));
      }
      if (b.dataset.naiModal === "persona-continue") {
        closeNaiModal();
        await runNaiPipeline(row, null);
      }
    });
  }

  function showAppearanceModal(onDone) {
    const info = naiCharInfo();
    closeNaiModal();
    const modal = openNaiModal(`
      <h3 class="rh-import-title">캐릭터 외형 설정 (최초 1회)</h3>
      <p class="rh-setting-desc">이미지 생성에 쓸 외형 프롬프트(영어 태그 권장)를 입력해 주세요. 페르소나 외형은 비워두면 캐릭터 1인 구도로만 생성돼요.</p>
      <label>캐릭터 외형 <textarea data-nai-field="char" placeholder="예: 1boy, blonde hair, blue eyes, tall, athletic build">${esc(info.appearance || "")}</textarea></label>
      <label>(선택) 페르소나 외형 <textarea data-nai-field="persona" placeholder="예: 1girl, long brown hair, hazel eyes, petite">${esc(info.persona || "")}</textarea></label>
      <div class="rh-nai-modal-actions">
        <button type="button" class="rh-btn" data-nai-modal="save-appearance">저장하고 계속</button>
        <button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">취소</button>
      </div>
    `);
    modal.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-nai-modal]");
      if (!b) return;
      if (b.dataset.naiModal === "close") closeNaiModal();
      if (b.dataset.naiModal === "save-appearance") {
        const charText = modal.querySelector("[data-nai-field='char']").value.trim();
        const personaText = modal.querySelector("[data-nai-field='persona']").value.trim();
        if (!charText) { showToast("캐릭터 외형을 입력해 주세요."); return; }
        await saveNaiCharInfo(charText, personaText);
        closeNaiModal();
        onDone?.();
      }
    });
  }

  function buildInstruction(chatText, overridePrompt) {
    const c = naiConfig();
    const info = naiCharInfo();
    const base = instructionFor(imgSvc());
    const personaRule = info.persona
      ? "페르소나 외형이 있으므로, 대화 상황에 따라 캐릭터 1인 구도 또는 캐릭터+페르소나 2인 구도(2people 태그) 중 알맞은 쪽을 선택."
      : "페르소나 외형이 없으므로 캐릭터 외형 위주의 1인 구도만 생성.";
    const chat = overridePrompt || chatText;
    // 구버전 지시문(자리표시 포함)은 그대로 치환 지원
    if (/\{(PERSONA_RULE|CHAR|PERSONA|CHAT)\}/.test(base)) {
      return base
        .replace("{PERSONA_RULE}", personaRule)
        .replace("{CHAR}", info.appearance || "(미입력)")
        .replace("{PERSONA}", info.persona || "(없음)")
        .replace("{CHAT}", chat);
    }
    // 새 방식: 지시문 뒤에 구도 규칙·외형·대화를 자동으로 붙인다
    return [
      base,
      "",
      `[구도 규칙] ${personaRule}`,
      `캐릭터 외형: ${info.appearance || "(미입력)"}`,
      `페르소나 외형: ${info.persona || "(없음)"}`,
      "최근 대화:",
      chat
    ].join("\n");
  }

  async function runNaiPipeline(row, forcedAiPrompt) {
    const c = naiConfig();
    const t = activeImgTemplate();
    const info = naiCharInfo();
    const text = messageTextOf(row);
    const key = msgKeyOf(info.roomId, text);
    closeNaiModal();
    const modal = openNaiModal(`
      <div class="rh-import-spinner"></div>
      <h3 class="rh-import-title" data-nai-step>1/2 · AI가 상황을 분석하는 중…</h3>
      <p class="rh-setting-desc" data-nai-note>대화 내용으로 프롬프트를 만들고 있어요.</p>
    `);
    // 1단계: AI 프롬프트 (여기서 실패하면 일반 실패 모달)
    let aiPrompt = forcedAiPrompt;
    let aiUsage = null;
    let aiCost = null;
    if (!aiPrompt) {
      try {
        // 최근 대화 최대 6개 블록
        const rows = collectMessageRows();
        const idx = rows.indexOf(row);
        const ctx = rows.slice(Math.max(0, idx - 5), idx + 1).map(messageTextOf).join("\n---\n").slice(-4500);
        const ai = await callAiPrompt(buildInstruction(ctx));
        aiPrompt = cleanAiPrompt(ai.text);
        aiUsage = ai.usage || null;
        if (!aiPrompt) throw new Error("AI가 프롬프트를 만들지 못했어요.");
        const rate = await getUsdKrw();
        aiCost = aiCostKrw(aiCfgFor(c.aiProvider).model || defaultAiModel(c.aiProvider), aiUsage, rate);
      } catch (error) {
        console.error("[Rofan Helper] AI 프롬프트 생성 실패", error);
        closeNaiModal();
        openNaiModal(`
          <h3 class="rh-import-title">프롬프트 생성 실패</h3>
          <p class="rh-setting-warn" style="display:block">${esc(String(error?.message || error))}</p>
          <div class="rh-nai-modal-actions"><button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">닫기</button></div>
        `).addEventListener("click", (e) => { if (e.target.closest("[data-nai-modal='close']")) closeNaiModal(); });
        return;
      }
      // 프롬프트를 받자마자 이력에 보존 — NAI가 실패해도 AI 비용이 날아가지 않게.
      await upsertPromptOnlyEntry(info, key, text, aiPrompt, aiUsage, aiCost);
    }
    // 2단계: NAI 이미지 (실패해도 프롬프트는 살아있는 결과 모달로)
    modal.querySelector("[data-nai-step]").textContent = `2/2 · ${({ nai: "NAI", gpt: "GPT", gemini: "Gemini", grok: "Grok" })[imgSvc()]} 이미지 생성 중…`;
    modal.querySelector("[data-nai-note]").textContent = aiPrompt.slice(0, 160);
    const seed = c.seedLocked && t.seed ? t.seed : Math.floor(Math.random() * 4294967295);
    try {
      const finalPrompt = t.hasPlaceholder
        ? t.prompt.replace(NAI_PLACEHOLDER_RE, aiPrompt)
        : `${t.prompt ? t.prompt + ", " : ""}${aiPrompt}`;
      const svc = imgSvc();
      let image;
      let imgCost = null;
      if (svc === "nai") {
        image = await callNaiGenerate(finalPrompt, seed);
      } else {
        const r = svc === "gpt" ? await callGptImage(finalPrompt)
          : svc === "gemini" ? await callGeminiImage(finalPrompt)
          : await callGrokImage(finalPrompt);
        image = r.dataUrl;
        if (r.costUsd != null) imgCost = r.costUsd * (await getUsdKrw());
      }
      // 저장: 방 이미지 교체 + 이력 (성공했으니 같은 대화의 이미지 없는 임시 항목은 정리)
      // 대화방 이미지는 생성 원본(PNG) 그대로 적용 — 압축하지 않는다. (이력 썸네일만 축소본)
      const thumb = await downscaleImage(image, 384, 0.85);
      ensureRoom(info.roomId, { customImage: image });
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        roomId: info.roomId,
        roomTitle: state.rooms[info.roomId]?.title || state.rooms[info.roomId]?.characterName || "",
        msgKey: key,
        msgExcerpt: text.slice(0, 120),
        aiPrompt,
        aiUsage,
        aiCostKrw: aiCost,
        imgCostKrw: imgCost,
        seed,
        thumb,
        createdAt: nowIso()
      };
      state.naiHistory = [...(state.naiHistory || []).filter((h) => !(h.msgKey === key && !h.thumb)), entry].slice(-100);
      await saveState();
      applyRoomCustomImage();
      injectMessageGenButtons();
      saveNaiImageFile(image, info); // 원본 PNG를 다운로드 폴더(RofanHelper/NAI/)에 저장
      showNaiResultModal(entry, row, image);
    } catch (error) {
      console.error("[Rofan Helper] NAI 이미지 생성 실패", error);
      // AI 프롬프트는 이미 확보 — 결과 모달로 넘어가 NAI만 재시도할 수 있게 한다.
      const saved = await upsertPromptOnlyEntry(info, key, text, aiPrompt, aiUsage, aiCost);
      injectMessageGenButtons();
      showNaiResultModal(saved, row, null, String(error?.message || error));
    }
  }

  // 생성 원본 PNG를 다운로드 폴더의 RofanHelper/NAI/ 하위에 저장 (실패해도 흐름에 영향 없음)
  function saveNaiImageFile(dataUrl, info) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    const base = String(state.rooms[info.roomId]?.title || state.rooms[info.roomId]?.characterName || "chat")
      .replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_").slice(0, 40) || "chat";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    chrome.runtime.sendMessage(
      { type: "rh-download", dataUrl, filename: `${base}_${stamp}.png` },
      () => void chrome.runtime.lastError
    );
  }

  // 이미지 없이 프롬프트만 보존하는 이력 항목(같은 대화에 하나만 유지)
  async function upsertPromptOnlyEntry(info, key, text, aiPrompt, aiUsage, aiCost) {
    const list = state.naiHistory || [];
    const existing = list.find((h) => h.msgKey === key && !h.thumb);
    if (existing) {
      existing.aiPrompt = aiPrompt;
      if (aiUsage) { existing.aiUsage = aiUsage; existing.aiCostKrw = aiCost; }
      existing.createdAt = nowIso();
      await saveState();
      return existing;
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      roomId: info.roomId,
      roomTitle: state.rooms[info.roomId]?.title || state.rooms[info.roomId]?.characterName || "",
      msgKey: key,
      msgExcerpt: text.slice(0, 120),
      aiPrompt,
      aiUsage: aiUsage || null,
      aiCostKrw: aiCost ?? null,
      seed: 0,
      thumb: "",
      createdAt: nowIso()
    };
    state.naiHistory = [...list, entry].slice(-100);
    await saveState();
    return entry;
  }

  function showNaiResultModal(entry, row, fullImage, errorMsg) {
    closeNaiModal();
    const history = (state.naiHistory || []).filter((h) => h.msgKey === entry.msgKey);
    const img = fullImage || entry.thumb;
    const modal = openNaiModal(`
      <h3 class="rh-import-title">이미지 생성</h3>
      ${errorMsg ? `<p class="rh-setting-warn" style="display:block">이미지 생성 실패: ${esc(errorMsg)}<br><strong>프롬프트는 저장돼 있어요</strong> — 아래에서 [이미지만 재생성]을 누르면 AI 비용 없이 이미지 생성만 다시 시도합니다.</p>` : ""}
      ${img ? `<img class="rh-nai-result-img" src="${esc(img)}" alt="">`
            : `<div class="rh-nai-noimg">아직 이미지가 없어요 — 프롬프트로 [이미지 재생성]을 눌러 주세요.</div>`}
      <label>프롬프트 (수정 후 이미지 재생성 가능)
        <textarea data-nai-field="prompt">${esc(entry.aiPrompt)}</textarea>
      </label>
      <p class="rh-nai-meta">${esc(usageLine(entry))}${entry.seed ? `시드 ${esc(String(entry.seed))} · ` : ""}${esc(fmtDate(entry.createdAt))}</p>
      ${history.length > 1 ? `
        <p class="rh-nai-tpl-head">이 대화의 생성 이력 (${history.length})</p>
        <div class="rh-nai-hist">${history.map((h) => h.thumb
          ? `<img src="${esc(h.thumb)}" title="${esc(h.aiPrompt.slice(0, 200))}" data-nai-hist="${esc(h.id)}">`
          : `<span class="rh-nai-hist-noimg" title="${esc(h.aiPrompt.slice(0, 200))}" data-nai-hist="${esc(h.id)}">P</span>`).join("")}</div>` : ""}
      <div class="rh-nai-modal-actions">
        <button type="button" class="rh-btn" data-nai-modal="regen-image">이미지만 재생성</button>
        <button type="button" class="rh-btn" data-nai-modal="regen-prompt">프롬프트부터 재생성</button>
        <button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="edit-appearance">외형 수정</button>
        <button type="button" class="rh-btn rh-btn-ghost" data-nai-modal="close">닫기</button>
      </div>
    `);
    modal.addEventListener("click", async (e) => {
      const hist = e.target.closest("[data-nai-hist]");
      if (hist) {
        const h = (state.naiHistory || []).find((x) => x.id === hist.dataset.naiHist);
        if (h) showNaiResultModal(h, row);
        return;
      }
      const b = e.target.closest("[data-nai-modal]");
      if (!b) return;
      if (b.dataset.naiModal === "close") closeNaiModal();
      if (b.dataset.naiModal === "edit-appearance") showAppearanceModal(() => showNaiResultModal(entry, row));
      if (b.dataset.naiModal === "regen-image") {
        const edited = modal.querySelector("[data-nai-field='prompt']").value.trim();
        await runNaiPipeline(row, edited || entry.aiPrompt);
      }
      if (b.dataset.naiModal === "regen-prompt") await runNaiPipeline(row, null);
    });
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso || ""; }
  }

  // --- 공용 NAI 모달 ---
  function openNaiModal(innerHtml) {
    let ov = $("#rofan-helper-nai-modal");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "rofan-helper-nai-modal";
      document.documentElement.append(ov);
    }
    ov.innerHTML = `<div class="rh-import-card rh-nai-card">${innerHtml}</div>`;
    ov.onclick = (e) => { if (e.target === ov) closeNaiModal(); };
    return ov;
  }

  function closeNaiModal() {
    $("#rofan-helper-nai-modal")?.remove();
  }


  async function handlePanelClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    const tab = button.dataset.tab;
    if (tab) {
      renderPanel(tab);
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === "close") panel.hidden = true;
    if (action === "open-character") openCharacter(button.dataset.id);
    if (action === "unhide-character") unhideCharacter(button.dataset.id);
    if (action === "export-data") exportData();
    if (action === "import-data") importData();
    if (action === "carousel-prev" || action === "carousel-next") scrollCarousel(button, action === "carousel-next");
    if (action === "data-section") {
      const key = button.dataset.section || "";
      dataSection = dataSection === key ? "" : key;
      renderPanel("data");
    }
    if (action === "creator-unfollow") await unfollowCreatorFromPanel(button.dataset.id);
    if (action === "open-creator-page" && button.dataset.id) {
      location.href = `/user/${encodeURIComponent(button.dataset.id)}`;
    }
    if (action === "creator-memo-toggle") {
      const box = $(`[data-creator-memo="${cssEscape(button.dataset.id || "")}"]`, panel);
      if (box) {
        box.hidden = !box.hidden;
        if (!box.hidden) $("textarea", box)?.focus();
      }
    }
    if (action === "save-creator-note" && button.dataset.id) {
      const ta = $(`textarea[data-field="creator-note"][data-id="${cssEscape(button.dataset.id)}"]`, panel);
      ensureCreator(button.dataset.id, { note: ta ? ta.value : "" });
      await saveState();
      showToast("메모를 저장했어요.");
    }
    if (action === "folder-color-mode") await setFolderColorMode(button.dataset.mode);
    if (action === "import-chatlist") await runImport("chatList");
    if (action === "import-follows") await runImport("follows");
    if (action === "import-creatorchars") await runImport("creatorChars");
    if (action === "refresh-follows") await refreshFollows();
    if (action === "save-fixed-input") {
      const ta = $('[data-field="chat-fixed-text"]', panel);
      const raw = ta ? ta.value : "";
      state.settings.chatInput = { ...(state.settings.chatInput || {}), fixedText: String(raw) };
      await saveState();
      pushChatInjectConfig();
      renderPanel("chatset");
    }
    if (action === "shortcut-add") {
      const trig = $(".rh-sc-new-trigger", panel)?.value || "";
      const cont = $(".rh-sc-new-content", panel)?.value || "";
      const trigger = trig.trim().replace(/^\/+/, ""); // 앞의 / 제거
      const content = cont.trim();
      if (!trigger || !content) { showToast("명령어와 내용을 모두 입력해 주세요."); return; }
      if (/[\s/]/.test(trigger)) { showToast("명령어에는 공백이나 /를 넣을 수 없어요."); return; }
      const sc = state.settings.shortcuts || (state.settings.shortcuts = { enabled: false, showChips: true, list: [] });
      sc.list = Array.isArray(sc.list) ? sc.list : [];
      const idx = sc.list.findIndex((s) => s.trigger === trigger);
      if (idx >= 0) sc.list[idx] = { trigger, content }; else sc.list.push({ trigger, content });
      await saveState();
      pushShortcutsConfig();
      renderPanel("chatset");
    }
    if (action === "shortcut-del") {
      const i = Number(button.dataset.index);
      const sc = state.settings.shortcuts || {};
      if (Array.isArray(sc.list) && i >= 0 && i < sc.list.length) {
        sc.list.splice(i, 1);
        await saveState();
        pushShortcutsConfig();
        renderPanel("chatset");
      }
    }
    if (action === "nai-save-ai") {
      const get = (f) => $(`[data-field="${f}"]`, panel)?.value ?? "";
      const c = { ...naiConfig() };
      c.aiCfg = { ...(c.aiCfg || {}) };
      c.aiCfg[c.aiProvider] = { key: get("nai-aikey").trim(), model: get("nai-aimodel").trim() };
      state.settings.nai = c;
      await saveState();
      renderPanel("chatset");
      queueApply();
      showToast("프롬프트 생성 AI 설정을 저장했어요.");
    }
    if (action === "nai-save-img") {
      const get = (f) => $(`[data-field="${f}"]`, panel)?.value ?? "";
      const c = { ...naiConfig() };
      const svc = imgSvc();
      if (svc === "nai") {
        c.naiKey = get("nai-naikey").trim();
        const idx = c.activeTemplate ?? 0;
        const t = (c.templates || [])[idx];
        if (t) {
          let tPrompt = get("nai-t-prompt");
          if (!NAI_PLACEHOLDER_RE.test(tPrompt)) {
            const trimmed = tPrompt.replace(/[\s,]+$/, "");
            tPrompt = trimmed ? `${trimmed},[[Input data]]` : "[[Input data]]";
          }
          c.templates = [...c.templates];
          c.templates[idx] = {
            ...t,
            prompt: tPrompt,
            negative: get("nai-t-negative"),
            model: get("nai-t-model").trim() || t.model,
            sampler: get("nai-t-sampler").trim() || t.sampler,
            steps: toNumber(get("nai-t-steps")) || t.steps,
            scale: Number(get("nai-t-scale")) || t.scale,
            width: toNumber(get("nai-t-width")) || t.width,
            height: toNumber(get("nai-t-height")) || t.height,
            hasPlaceholder: NAI_PLACEHOLDER_RE.test(tPrompt)
          };
        }
      } else {
        // GPT/Gemini/Grok: 키는 프롬프트 생성 AI와 공유 저장
        const prov = IMG_SERVICES[svc].provider;
        c.aiCfg = { ...(c.aiCfg || {}) };
        c.aiCfg[prov] = { ...(c.aiCfg[prov] || {}), key: get("img-key").trim(), model: c.aiCfg[prov]?.model || "" };
        let iPrompt = get("img-prompt");
        if (iPrompt.trim() && !NAI_PLACEHOLDER_RE.test(iPrompt)) {
          const trimmed = iPrompt.replace(/[\s,]+$/, "");
          iPrompt = `${trimmed},[[Input data]]`;
        }
        c.imgCfg = { ...(c.imgCfg || {}) };
        c.imgCfg[svc] = {
          ...(c.imgCfg[svc] || {}),
          model: get("img-model").trim(),
          prompt: iPrompt,
          ...(svc === "gpt" ? { size: get("img-size") || "1024x1536" } : {})
        };
      }
      // 서비스별 지시문 저장
      c.instructions = { ...(c.instructions || {}), [svc]: get("img-instruction") };
      state.settings.nai = c;
      await saveState();
      renderPanel("chatset");
      queueApply();
      showToast("이미지 생성 설정을 저장했어요.");
    }
    if (action === "nai-style-slot") {
      const c = { ...naiConfig() };
      const to = Number(button.dataset.slot) || 0;
      const from = c.activeTemplate ?? 0;
      // 전환 전 현재 슬롯의 편집 중 값 보존
      const t = (c.templates || [])[from];
      const get = (f) => $(`[data-field="${f}"]`, panel)?.value;
      if (t && get("nai-t-prompt") !== undefined) {
        c.templates = [...c.templates];
        c.templates[from] = {
          ...t,
          prompt: get("nai-t-prompt"),
          negative: get("nai-t-negative"),
          model: (get("nai-t-model") || t.model).trim(),
          sampler: (get("nai-t-sampler") || t.sampler).trim(),
          steps: toNumber(get("nai-t-steps")) || t.steps,
          scale: Number(get("nai-t-scale")) || t.scale,
          width: toNumber(get("nai-t-width")) || t.width,
          height: toNumber(get("nai-t-height")) || t.height,
          hasPlaceholder: NAI_PLACEHOLDER_RE.test(get("nai-t-prompt") || "")
        };
      }
      if ($('[data-field="nai-naikey"]', panel)) c.naiKey = $('[data-field="nai-naikey"]', panel).value.trim();
      c.activeTemplate = to;
      state.settings.nai = c;
      await saveState();
      renderPanel("chatset");
    }
    if (action === "nai-test") await testNaiConnection();
    if (action === "nai-instruction-reset") {
      const c = { ...naiConfig() };
      c.instructions = { ...(c.instructions || {}), [imgSvc()]: "" };
      if (imgSvc() === "nai") c.promptInstruction = "";
      state.settings.nai = c;
      await saveState();
      renderPanel("chatset");
      showToast(`${IMG_SERVICES[imgSvc()].label} 지시문을 기본값으로 되돌렸어요.`);
    }
    if (action === "nai-hist-del") {
      state.naiHistory = (state.naiHistory || []).filter((h) => h.id !== button.dataset.id);
      await saveState();
      renderPanel("data");
    }
    if (action === "nai-hist-clear") {
      state.naiHistory = [];
      await saveState();
      renderPanel("data");
    }
    if (action === "nai-copy-prompt") copyNaiPrompt(button.dataset.id);
    if (action === "nai-open-folder") {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "rh-show-folder" }, () => void chrome.runtime.lastError);
      } else {
        showToast("확장 환경에서만 폴더를 열 수 있어요.");
      }
    }
    if (action === "save-appearance-row") {
      const id = button.dataset.id;
      const ta = $(`textarea[data-appearance-id="${cssEscape(id)}"]`, panel);
      if (id && ta) {
        ensureCharacter(id, { appearance: ta.value.trim() });
        await saveState();
        showToast("외형 프롬프트를 저장했어요.");
      }
    }
  }

  async function setFolderColorMode(mode) {
    const fc = state.settings.chatCardFolderColor || (state.settings.chatCardFolderColor = { background: false, border: false });
    if (mode === "none") {
      fc.background = false;
      fc.border = false;
    } else if (mode === "background" || mode === "border") {
      fc[mode] = !fc[mode];
    }
    await saveState();
    renderPanel("etc");
    applyEnhancements({ preserveEditors: true });
  }

  function scrollCarousel(button, forward) {
    const track = $(".rh-carousel-track", button.closest(".rh-carousel"));
    if (!track) return;
    track.scrollBy({ left: (forward ? 1 : -1) * Math.max(160, track.clientWidth * 0.8), behavior: "smooth" });
  }

  async function unfollowCreatorFromPanel(id) {
    if (!id) return;
    await toggleCreatorFollowFromMenu(id);
    renderPanel("creator");
  }

  async function handlePanelInput(event) {
    const field = event.target.dataset.field;
    if (!field) return;
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    const id = event.target.dataset.id;

    if (field === "import-json") return;
    // 제작자 메모는 입력 중엔 저장하지 않고 [저장] 버튼을 눌러야 저장된다(초안만 유지).
    if (field === "creator-note") return;
    if (field === "chat-fixed-text") {
      // 입력 중에는 미리보기(글자수/경고)만 갱신하고, 실제 저장·전송은 [저장] 버튼에서 처리한다.
      const countEl = $(".rh-setting-count strong", panel);
      if (countEl) countEl.textContent = String(buildFixedInputMarkup(value).length);
      const warn = $(".rh-setting-warn", panel);
      if (warn) warn.hidden = !/[<>]/.test(String(value));
      return;
    }
  }

  async function handlePanelChange(event) {
    const field = event.target.dataset.field;
    if (field === "chat-fixed-enabled") {
      state.settings.chatInput = { ...(state.settings.chatInput || {}), fixedEnabled: Boolean(event.target.checked) };
      await saveState();
      pushChatInjectConfig();
    }
    if (field === "shortcut-enabled") {
      state.settings.shortcuts = { ...(state.settings.shortcuts || {}), enabled: Boolean(event.target.checked) };
      await saveState();
      pushShortcutsConfig();
    }
    if (field === "shortcut-chips") {
      state.settings.shortcuts = { ...(state.settings.shortcuts || {}), showChips: Boolean(event.target.checked) };
      await saveState();
      updateShortcutUI();
    }
    if (field === "nai-enabled") {
      state.settings.nai = { ...naiConfig(), enabled: Boolean(event.target.checked) };
      await saveState();
      renderPanel("chatset");
      queueApply();
    }
    if (field === "nai-seed-locked") {
      state.settings.nai = { ...naiConfig(), seedLocked: Boolean(event.target.checked) };
      await saveState();
    }
    if (field === "nai-provider") {
      const c = { ...naiConfig() };
      const prev = c.aiProvider;
      // 전환 전 현재 입력을 이전 제공사 칸에 보존
      const key = $('[data-field="nai-aikey"]', panel)?.value;
      const model = $('[data-field="nai-aimodel"]', panel)?.value;
      c.aiCfg = { ...(c.aiCfg || {}) };
      if (key !== undefined) c.aiCfg[prev] = { key: key.trim(), model: (model || "").trim() };
      c.aiProvider = String(event.target.value);
      state.settings.nai = c;
      await saveState();
      renderPanel("chatset");
    }
    if (field === "nai-imgprovider") {
      state.settings.nai = { ...naiConfig(), imgProvider: String(event.target.value) };
      await saveState();
      renderPanel("chatset");
    }
    if (field === "nai-template-file") {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const template = await extractNaiTemplate(file);
        if (!template) { showToast("이미지에서 NAI 생성 정보를 찾지 못했어요. NAI에서 저장한 원본 PNG인지 확인해 주세요."); return; }
        const c = { ...naiConfig() };
        // 재렌더로 입력 중이던 값이 날아가지 않게 보존
        const grab = (f) => $(`[data-field="${f}"]`, panel)?.value;
        if (grab("nai-naikey") !== undefined) c.naiKey = grab("nai-naikey").trim();
        if (grab("nai-aikey") !== undefined) {
          c.aiCfg = { ...(c.aiCfg || {}) };
          c.aiCfg[c.aiProvider] = { key: grab("nai-aikey").trim(), model: (grab("nai-aimodel") || "").trim() };
        }
        c.templates = Array.isArray(c.templates) ? [...c.templates] : [null, null, null, null];
        c.templates[c.activeTemplate ?? 0] = template;
        state.settings.nai = c;
        await saveState();
        renderPanel("chatset");
        showToast(`그림체${(c.activeTemplate ?? 0) + 1}에 템플릿을 저장했어요.`);
      } catch (error) {
        console.error("[Rofan Helper] 템플릿 파싱 실패", error);
        showToast("템플릿 이미지를 읽지 못했어요.");
      }
    }
  }

  function ensureRoom(id, patch = {}) {
    if (!id) return null;
    const prev = state.rooms[id] || {};
    const cleanPatch = {};
    const deleteKeys = [];
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value === undefined) return;
      if (value === null) { deleteKeys.push(key); return; } // 명시적 null = 해당 필드 삭제(예: 스티커 제거)
      if (value === "" && !["note", "characterAvatar", "personaAvatar"].includes(key)) return;
      cleanPatch[key] = value;
    });
    state.rooms[id] = {
      id,
      firstSeenAt: prev.firstSeenAt || nowIso(),
      ...prev,
      ...cleanPatch,
      updatedAt: nowIso()
    };
    deleteKeys.forEach((key) => { delete state.rooms[id][key]; });
    return state.rooms[id];
  }

  async function scanAndRefresh() {
    await ingestPageData();
    applyEnhancements({ preserveEditors: true });
    renderPanel(panel.dataset.tab);
  }

  // 사이트 캐릭터 모달은 React 상태로만 열려 외부에서 임의 캐릭터를 띄울 수 없으므로,
  // 동일 정보 + "최근 설정 불러오기"가 정상 동작하는 캐릭터 페이지로 이동한다.
  function openCharacter(id) {
    if (!id) return;
    location.href = `/character/${id}`;
  }

  async function toggleCharacterHidden(id) {
    if (!id) return;
    const char = state.characters[id] || {};
    ensureCharacter(id, { hidden: !char.hidden });
    await saveState();
    applyEnhancements({ preserveEditors: true });
    renderPanel("home");
  }

  async function unhideCharacter(id) {
    if (!id) return;
    ensureCharacter(id, { hidden: false });
    await saveState();
    applyEnhancements({ preserveEditors: true });
    renderPanel("home");
  }

  async function markPlayedAndRefresh(id) {
    if (!id) return;
    markPlayed(id);
    await saveState();
    applyEnhancements({ preserveEditors: true });
    renderPanel("home");
  }

  async function toggleCreator(id, key) {
    if (!id) return;
    const creator = state.creators[id] || {};
    ensureCreator(id, { [key]: !creator[key] });
    await saveState();
    if (key === "hidden") revealedCreatorCharacters.clear();
    applyEnhancements({ preserveEditors: true });
    renderPanel("creator");
  }

  function collectCards() {
    return uniqueBy($$("a[href*='/character/']").map((anchor) => {
      const id = anchor.href.match(UUID_RE)?.[0];
      if (!id) return null;
      // 캐릭터 모달(fixed inset-0) 안의 링크는 카드가 아니다 —
      // 모달을 카드로 착각해 position:relative를 먹이면 모달이 페이지 아래로 떨어진다
      if (anchor.closest("[class*='fixed'][class*='inset-0']")) return null;
      return { id, anchor, card: findCardContainer(anchor) };
    }).filter(Boolean), (item) => item.anchor);
  }

  function cardScore(node) {
    if (!node) return 0;
    const rect = node.getBoundingClientRect();
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function findCardContainer(anchor) {

    const id = anchor.href.match(UUID_RE)?.[0];
    let candidate = anchor;
    let node = anchor.parentElement;

    for (let i = 0; i < 10 && node && node !== document.body && node !== document.documentElement; i += 1) {
      const ids = characterIdsIn(node);
      if (ids.size > 1) break;
      if (ids.has(id)) candidate = node;
      node = node.parentElement;
    }

    return candidate;
  }

  function characterIdsIn(node) {
    const ids = new Set();
    if (node.matches?.("a[href*='/character/']")) {
      const id = node.href?.match(UUID_RE)?.[0];
      if (id) ids.add(id);
    }
    $$("a[href*='/character/']", node).forEach((link) => {
      const id = link.href.match(UUID_RE)?.[0];
      if (id) ids.add(id);
    });
    return ids;
  }

  // 주의: 예전에는 <a> 카드를 우리 div(.rh-card-shell)로 감쌌는데,
  // React가 소유한 노드의 부모를 바꾸면 페이지 전환/리스트 갱신 때
  // removeChild가 실패해 "Application error" 크래시를 일으킨다.
  // 이제 감싸지 않고 카드(앵커 포함) 자체를 host로 쓴다 —
  // 자식을 '추가'하는 것은 안전하지만 '재부모화'는 절대 금지.
  function ensureCardHost(anchor, card) {
    return card;
  }

  function applyEnhancements(options = {}) {
    // 페이지 전환 직후에는 React 언마운트/마운트와 겹치지 않게 잠시 대기 후 재시도
    if (Date.now() < navigationPauseUntil) {
      clearTimeout(applyEnhancements.__pauseRetry);
      applyEnhancements.__pauseRetry = setTimeout(() => applyEnhancements(options), navigationPauseUntil - Date.now() + 100);
      return;
    }
    document.documentElement.classList.add("rh-card-expanded");
    state.settings.cardInfoExpanded = true;
    // 캐릭터 모달이 열려 있는 동안은 카드 장식을 완전히 동결한다.
    // (queueApply 외에 제작자 조회 완료 등 다른 경로로 호출돼도 동일하게 적용)
    if (hasOpenCharacterModal()) {
      fixCharacterModalPositioning();
      enhanceCharacterModals();
      return;
    }
    fixCharacterModalPositioning();
    enhanceCards(options);
    markCharacterModalHosts();
    enhanceCharacterModals();
    enhanceCreatorProfileLinks();
    enhanceChatList();
    updateChatCounterOffset();
    updateShortcutUI();
    enhanceNaiChatTools();
  }

  // 캐릭터 상세 페이지의 제작자 링크(<a href="/user/{id}">)를 눌렀을 때
  // 페이지 이동 대신 Helper 제작자 메뉴가 뜨도록 한다.
  function enhanceCreatorProfileLinks() {
    if (!isCharacterDetailPage()) return;
    $$("a[href*='/user/']").forEach((link) => {
      if (isHelperElement(link)) return;
      const id = link.href?.match(UUID_RE)?.[0];
      if (!id) return;
      if (link.dataset.rhCreatorLink === id) return;
      link.dataset.rhCreatorLink = id;
      link.dataset.rhCreatorId = id;
      link.dataset.rhCreatorName = creatorDisplayName(state.creators[id]) || "제작자";
      link.classList.add("rh-creator-menu-trigger");
      if (!creatorDisplayName(state.creators[id])) queueCreatorLookup(id);
      // 캡처 단계로 Next.js Link의 클릭 내비게이션보다 먼저 가로챈다
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const cid = link.dataset.rhCreatorId;
        if (creatorMenu && !creatorMenu.hidden && creatorMenu.dataset.creatorId === cid) {
          closeCreatorMenu();
          return;
        }
        showCreatorMenu(link);
      }, true);
    });
  }

  function applyCustomStyle() {
    let style = $("#rofan-helper-custom-style");
    if (!style) {
      style = document.createElement("style");
      style.id = "rofan-helper-custom-style";
      document.head.append(style);
    }
    const font = state.settings.fontFamily?.trim()
      ? `html, body, button, input, textarea, select { font-family: ${state.settings.fontFamily} !important; }`
      : "";
    style.textContent = `${font}\n${state.settings.customCSS || ""}`;
  }

  function enhanceCards(options = {}) {
    const currentIds = new Set();
    const currentHosts = new Set();
    const currentGridHosts = new Set();
    const newSectionContainers = findNewSectionContainers();
    let missingNewSectionData = false;
    collectCards().forEach(({ id, anchor, card }) => {
      currentIds.add(id);
      const host = ensureCardHost(anchor, card);
      currentHosts.add(host);
      if (host.parentElement) currentGridHosts.add(host.parentElement);
      const char = mergedCharacterInfo(id, anchor);
      const creator = char.creatorId ? state.creators[char.creatorId] || {} : {};
      const newSectionCard = newSectionContainers.some((container) => container.contains(anchor));
      if (newSectionCard && !botById(id)) missingNewSectionData = true;
      if (char.creatorId && !creatorDisplayName(creator)) queueCreatorLookup(char.creatorId);
      const hiddenByChar = char.hidden;
      const hiddenByCreator = creator.hidden && !revealedCreatorCharacters.has(id);
      const hiddenByTag = (char.tags || []).some((tag) => state.settings.hiddenTags.includes(tag) || state.settings.excludedGenders.includes(tag));
      host.classList.toggle("rh-hidden-card", Boolean(hiddenByChar || hiddenByTag));
      host.classList.toggle("rh-creator-muted", Boolean(hiddenByCreator));
      host.classList.add("rh-enhanced-card");
      host.classList.toggle("rh-new-section-card", newSectionCard);
      host.dataset.rhCharacterId = id;
      host.dataset.rhCreatorId = char.creatorId || "";
      host.parentElement?.classList.add("rh-card-grid-host");
      syncCardImageStats(anchor, char, creator, { newSectionCard });
      syncNativeNewBadge(anchor, char, { newSectionCard });
      anchor.addEventListener("click", () => {
        const bot = botById(id);
        markViewed(id, bot ? botToCharacterPatch(bot) : { name: char.name });
        saveState();
      }, { once: true });

      let info = $(":scope > .rh-card-info", host);
      const editorWasOpen = info && !$(".rh-inline-editor", info)?.hidden;
      const editorHasFocus = info?.contains(document.activeElement);
      if (!info) {
        info = document.createElement("div");
        info.className = "rh-card-info";
        host.append(info);
      }
      const renderKey = cardRenderKey(id, char, creator, { newSectionCard });
      const shouldRender = info.dataset.rhRenderKey !== renderKey;
      if (shouldRender && (!options.preserveEditors || (!editorWasOpen && !editorHasFocus))) {
        info.innerHTML = renderCardInfo(id, char, creator, anchor, { newSectionCard });
        info.dataset.rhRenderKey = renderKey;
      }
    });
    lastEnhancedIds = currentIds;
    cleanupStaleCards(currentIds, currentGridHosts, currentHosts);
    // 안전망: 네이티브 대화수 배지를 숨겼는데 Helper 통계가 사라졌다면(React 재렌더 등)
    // 사이트 원래 배지라도 복구한다 — "통계가 사라지고 안 돌아오는" 상태 방지
    $$(".rh-native-chat-hidden").forEach((node) => {
      const scope = node.closest(".rh-enhanced-card") || node.closest("a[href*='/character/']") || node.parentElement;
      if (scope && !$(".rh-card-image-stats", scope)) node.classList.remove("rh-native-chat-hidden");
    });
    if (missingNewSectionData) ensureRecentBotsData();
  }

  function enhanceCharacterModals() {
    markCharacterModalHosts();
    fixCharacterModalPositioning();
    let changed = false;
    findCharacterModalRoots().forEach((root) => {
      $$("a[href*='/user/']", root).forEach((link) => {
        const id = link.href?.match(UUID_RE)?.[0];
        if (!id) return;
        // 모달 텍스트에서 이름을 수확하지 않는다 — 로딩 중 id 조각/엉뚱한 텍스트가
        // 저장되는 원인이었다. 이름은 프로필 조회로만 확보한다.
        if (!creatorDisplayName(state.creators[id])) queueCreatorLookup(id);
        const label = creatorDisplayName(state.creators[id]);
        link.classList.add("rh-creator-menu-trigger", "rh-modal-creator-trigger");
        link.dataset.rhCreatorId = id;
        link.dataset.rhCreatorName = creatorDisplayName(state.creators[id]) || label || "제작자";
        link.title = "제작자 메뉴";
      });
      syncModalAverageStat(root);
      syncModalAssetControls(root);
    });
    if (changed) scheduleHookStateSave();
  }

  function markCharacterModalHosts(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    $$(".rh-modal-open-host").forEach((host) => {
      if (!characterModalCandidateNodes(host).length) {
        host.classList.remove("rh-modal-open-host");
      }
    });
    characterModalCandidateNodes(scope).forEach((node) => {
      node.closest(".rh-card-shell, .rh-enhanced-card, .rh-creator-muted")?.classList.add("rh-modal-open-host");
    });
  }

  function isRofanCharacterModalCandidate(node) {
    // 주의: isHelperElementStrict를 쓰면 안 된다 — 모달이 카드로 오염돼
    // rh-card-image-host 같은 장식 클래스를 받으면 "Helper 요소"로 오인되어
    // 감지에서 빠지고, 치유/위치 보정이 영영 그 모달만 건너뛰게 된다.
    // Helper가 '직접 만든' 요소(id 루트/생성 요소)만 제외한다.
    if (!node || isHelperOwnedRoot(node)) return false;
    const className = String(node.className || "");
    if (!className.includes("fixed") || !className.includes("inset-0")) return false;
    if (!$("a[href*='/user/']", node) || !$("img", node)) return false;
    const text = compact(node.innerText || node.textContent || "", 1400);
    return text.includes("#") || /세계관|캐릭터\s*소개|제작자\s*코멘트|캐릭터\s*정보/.test(text);
  }

  function isHelperOwnedRoot(node) {
    return Boolean(node.closest?.(
      "#rofan-helper-launcher, #rofan-helper-nav-button, #rofan-helper-panel, #rofan-helper-toast, #rofan-helper-creator-menu"
        + ", #rofan-helper-room-editor, #rofan-helper-room-dialog, #rofan-helper-sticker-toolbar, #rofan-helper-char-modal"
        + ", .rh-card-info, .rh-card-image-stats, .rh-room-sticker-overlay, .rh-room-note-line, .rh-room-menu-items"
    ));
  }

  function characterModalCandidateNodes(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    const nodes = [
      ...(scope.matches?.("div.fixed.inset-0, [class*='fixed'][class*='inset-0'], [role='dialog'], [aria-modal='true']") ? [scope] : []),
      ...$$("div.fixed.inset-0, [class*='fixed'][class*='inset-0'], [role='dialog'], [aria-modal='true']", scope)
    ];
    return uniqueBy(nodes.filter(isRofanCharacterModalCandidate), (node) => node);
  }

  function syncModalAverageStat(root) {
    const stats = findModalStatsGroup(root);
    if (!stats) return;
    const statItems = Array.from(stats.children).filter((node) => node.tagName === "DIV" && $("svg", node));
    if (statItems.length < 2) return;
    const chatCount = toNumber($("span", statItems[0])?.textContent || statItems[0].innerText);
    const userCount = toNumber($("span", statItems[1])?.textContent || statItems[1].innerText);
    let badge = Array.from(stats.children).find((node) => node.classList?.contains("rh-modal-average-stat"));
    if (!chatCount || !userCount) {
      badge?.remove();
      return;
    }
    const average = (chatCount / userCount).toFixed(1);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "rh-modal-average-stat";
      stats.append(badge);
    }
    badge.textContent = `(평균${average})`;
    badge.title = `총 대화 ${formatCount(chatCount)} / 대화 인원 ${formatCount(userCount)}`;
  }

  function findModalStatsGroup(root) {
    return $$("div", root).find((node) => {
      if (Array.from(node.children).some((child) => child.classList?.contains("rh-modal-average-stat"))) return true;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const statItems = Array.from(node.children).filter((child) => child.tagName === "DIV" && $("svg", child));
      if (statItems.length < 2) return false;
      const values = statItems.slice(0, 2).map((child) => compact($("span", child)?.textContent || child.innerText || "", 20));
      return values.every((value) => /^\d+(?:\.\d+)?(?:천|만)?$/.test(value));
    });
  }

  function syncModalAssetControls(root) {
    const imageBox = findModalImageBox(root);
    if (!imageBox) return;
    const strip = findModalAssetStrip(imageBox);
    if (!strip) return;
    imageBox.classList.add("rh-modal-asset-host");
    strip.classList.add("rh-modal-asset-strip");

    const navButtons = modalAssetNavButtons(strip);
    if (navButtons.some((button) => !isModalAssetNavBlocked(button))) strip.dataset.rhHadPaging = "1";
    const hadPaging = strip.dataset.rhHadPaging === "1";
    const createdRefresh = $(".rh-modal-refresh-created", strip);
    const prevButton = modalAssetPrevButton(strip);
    const nextButton = modalAssetNextButton(strip);
    const prevBlocked = isModalAssetNavBlocked(prevButton);
    const nextBlocked = isModalAssetNavBlocked(nextButton);
    if (imageBox.dataset.rhAssetPageIndex) strip.dataset.rhPageIndex = imageBox.dataset.rhAssetPageIndex;
    if (prevBlocked) {
      imageBox.dataset.rhAssetPageIndex = "0";
      strip.dataset.rhPageIndex = "0";
    }
    const isLastPage = hadPaging && !prevBlocked && (!nextButton || nextBlocked);

    if (!hadPaging) {
      createdRefresh?.remove();
      restoreModalNextButton(nextButton);
      return;
    }

    if (isLastPage) {
      restoreModalNextButton(nextButton);
      ensureModalCreatedRefreshButton(strip);
      return;
    }

    createdRefresh?.remove();
    restoreModalNextButton(nextButton);
  }

  function modalAssetNavButtons(strip) {
    if (!strip) return [];
    return $$("button", strip).filter((button) => $("svg", button) && !$("img", button) && !button.classList.contains("rh-modal-refresh-created"));
  }

  function modalAssetPrevButton(strip) {
    const navButtons = modalAssetNavButtons(strip);
    return navButtons.find(isModalPrevButton)
      || navButtons.find((button) => button.getBoundingClientRect().left < strip.getBoundingClientRect().left + strip.getBoundingClientRect().width / 2)
      || navButtons[0]
      || null;
  }

  function modalAssetNextButton(strip) {
    const navButtons = modalAssetNavButtons(strip);
    return navButtons.find(isModalNextButton)
      || navButtons.find((button) => button.getBoundingClientRect().left > strip.getBoundingClientRect().left + strip.getBoundingClientRect().width / 2)
      || navButtons[1]
      || null;
  }

  function isModalPrevButton(button) {
    const path = $("path", button)?.getAttribute("d") || "";
    return /M15\s*19l-7-7\s*7-7/i.test(path);
  }

  function isModalNextButton(button) {
    const path = $("path", button)?.getAttribute("d") || "";
    return /M9\s*5l7\s*7-7\s*7/i.test(path);
  }

  function isModalAssetNavBlocked(button) {
    if (!button) return true;
    return button.disabled || button.classList.contains("invisible") || getComputedStyle(button).visibility === "hidden";
  }

  function restoreModalNextButton(button) {
    if (!button?.classList?.contains("rh-modal-refresh-button")) return;
    button.classList.remove("rh-modal-refresh-button");
    button.title = "";
    button.removeAttribute("aria-label");
    button.innerHTML = button.dataset.rhOriginalHtml || button.innerHTML;
  }

  function ensureModalCreatedRefreshButton(strip) {
    if ($(".rh-modal-refresh-created", strip)) return;
    const row = $("button", strip)?.parentElement || strip;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bg-transparent px-[1px] py-2.5 lg:p-2 rh-modal-refresh-button rh-modal-refresh-created";
    button.title = "처음 에셋으로 이동";
    button.setAttribute("aria-label", "처음 에셋으로 이동");
    button.innerHTML = ICONS.refresh;
    row.append(button);
  }

  async function resetModalAssetsToFirst(button) {
    const imageBox = button.closest(".rh-modal-asset-host");
    if (!imageBox) return;

    for (let index = 0; index < 40; index += 1) {
      const strip = findModalAssetStrip(imageBox);
      clickFirstModalAsset(strip);
      const prevButton = modalAssetPrevButton(strip);
      if (!prevButton || isModalAssetNavBlocked(prevButton)) break;
      prevButton.click();
      await delay(90);
    }

    const strip = findModalAssetStrip(imageBox);
    clickFirstModalAsset(strip);
    await delay(80);
    const root = imageBox.closest("div.fixed.inset-0, [class*='fixed'][class*='inset-0']");
    imageBox.dataset.rhAssetPageIndex = "0";
    if (strip) strip.dataset.rhPageIndex = "0";
    if (root) syncModalAssetControls(root);
  }

  function clickFirstModalAsset(strip) {
    const firstImage = strip ? $("img", strip) : null;
    const target = firstImage?.closest("button, [role='button']") || firstImage?.parentElement;
    target?.click();
  }

  function scheduleModalAssetNavigationTrack(event) {
    const button = event.target.closest("button");
    const strip = button?.closest(".rh-modal-asset-strip");
    if (!button || !strip || button.classList.contains("rh-modal-refresh-button")) return;
    const imageBox = strip.closest(".rh-modal-asset-host");
    if (!imageBox) return;
    const direction = isModalNextButton(button) ? 1 : isModalPrevButton(button) ? -1 : 0;
    if (!direction) return;
    const before = modalAssetPageSignature(strip);
    setTimeout(() => updateModalAssetPageIndex(imageBox, before, direction), 180);
    setTimeout(() => updateModalAssetPageIndex(imageBox, before, direction), 520);
  }

  function updateModalAssetPageIndex(imageBox, before, direction) {
    const strip = findModalAssetStrip(imageBox);
    if (!strip) return;
    const after = modalAssetPageSignature(strip);
    if (!after || after === before || strip.dataset.rhLastTrackedSignature === after) return;
    strip.dataset.rhLastTrackedSignature = after;
    const current = Math.max(0, Number(imageBox.dataset.rhAssetPageIndex || strip.dataset.rhPageIndex || 0));
    const next = Math.max(0, current + direction);
    imageBox.dataset.rhAssetPageIndex = String(next);
    strip.dataset.rhPageIndex = String(next);
  }

  async function waitForModalAssetPageChange(imageBox, before, timeout = 900) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      await delay(80);
      const strip = findModalAssetStrip(imageBox);
      const next = modalAssetPageSignature(strip);
      if (next && next !== before) return true;
    }
    return false;
  }

  function modalAssetPageSignature(strip) {
    if (!strip) return "";
    return $$("img", strip).map((img) => img.currentSrc || img.src || "").join("|");
  }

  function findModalImageBox(root) {
    return $$("div", root).find((node) => {
      const className = String(node.className || "");
      return className.includes("aspect-w-2") && className.includes("aspect-h-3") && $("img", node);
    });
  }

  function findModalAssetStrip(imageBox) {
    return $$("div", imageBox).find((node) => {
      const className = String(node.className || "");
      return className.includes("absolute") && className.includes("bottom-0") && className.includes("left-1/2") && $$("img", node).length > 0;
    });
  }

  /* ------------------------------------------------------------------
     캐릭터 모달 위치 보정.
     rofan 모달은 position:fixed inset-0인데, 조상 중 transform/filter/
     backdrop-filter/perspective/contain/will-change를 가진 요소가 있으면
     fixed의 기준이 뷰포트가 아니라 그 조상이 되어 모달이 카드/섹션 위치
     (페이지 아래쪽)에 떠 버린다. 모달이 열려 있는 동안 조상 체인의 해당
     속성을 저장해 두고 중화했다가, 닫히면 원복한다.
     ------------------------------------------------------------------ */
  const modalNeutralizedNodes = [];

  function fixCharacterModalPositioning() {
    const modals = characterModalCandidateNodes();
    if (!modals.length) {
      restoreModalAncestorStyles();
      return;
    }
    modals.forEach((modal) => {
      // 치유: 모달이 카드로 오인돼 받은 Helper 카드 클래스/주입 UI 제거
      // (position:relative !important 클래스가 fixed를 덮어 모달이 페이지 아래로 떨어지는 원인)
      healContaminatedModal(modal);
      forceCharacterModalRoot(modal);
      // body/html까지 포함 — 스무스 스크롤류 확장이 body에 transform을 거는 경우도 잡는다
      let node = modal.parentElement;
      while (node) {
        neutralizeContainingBlock(node);
        node = node.parentElement;
      }
    });
  }

  function healContaminatedModal(modal) {
    const cardClasses = ["rh-enhanced-card", "rh-card-image-host", "rh-hidden-card", "rh-new-section-card", "rh-card-grid-host", "rh-creator-muted"];
    [modal, ...$$(".rh-enhanced-card, .rh-card-image-host, .rh-creator-muted", modal)].forEach((node) => {
      if (!cardClasses.some((cls) => node.classList.contains(cls))) return;
      cardClasses.forEach((cls) => node.classList.remove(cls));
      delete node.dataset.rhCharacterId;
    });
    // 모달 안에 잘못 주입된 카드 UI 제거
    $$(".rh-card-info", modal).forEach((node) => node.remove());
    // 모달 내부 요소를 감싼 카드 셸 래퍼는 풀어준다
    $$(".rh-card-shell", modal).forEach((shell) => {
      const child = shell.firstElementChild;
      if (child) shell.replaceWith(child);
      else shell.remove();
    });
  }

  function forceCharacterModalRoot(modal) {
    modal.classList.add("rh-character-modal-root");
    const forced = {
      position: "fixed",
      inset: "0",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      minWidth: "100vw",
      minHeight: "100vh",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      transform: "none"
    };
    // z-index는 강제하지 않는다 — 초대형 z-index를 씌우면 사이트가 이 모달 위에 여는
    // 하위 모달("최근 설정 불러오기" 등)이 뒤로 묻힌다. 위치는 position:fixed +
    // 조상 transform 중화로 이미 교정되므로 사이트 원래 z-index를 그대로 둔다.
    Object.entries(forced).forEach(([prop, value]) => {
      modal.style.setProperty(prop.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`), value, "important");
    });
  }

  function neutralizeContainingBlock(node) {
    if (node.__rhModalNeutralized) return;
    const style = getComputedStyle(node);
    const overrides = {};
    if (style.transform && style.transform !== "none") overrides.transform = "none";
    if (style.filter && style.filter !== "none") overrides.filter = "none";
    if (style.backdropFilter && style.backdropFilter !== "none") overrides["backdrop-filter"] = "none";
    if (style.perspective && style.perspective !== "none") overrides.perspective = "none";
    if (style.translate && style.translate !== "none") overrides.translate = "none";
    if (style.scale && style.scale !== "none") overrides.scale = "none";
    if (style.rotate && style.rotate !== "none") overrides.rotate = "none";
    if (style.willChange && /transform|filter|perspective/i.test(style.willChange)) overrides["will-change"] = "auto";
    if (style.contain && /paint|layout|strict|content/i.test(style.contain)) overrides.contain = "none";
    if (style.contentVisibility && style.contentVisibility !== "visible") overrides["content-visibility"] = "visible";
    const props = Object.keys(overrides);
    if (!props.length) return;
    const saved = {};
    props.forEach((prop) => {
      saved[prop] = [node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)];
      node.style.setProperty(prop, overrides[prop], "important");
    });
    node.__rhModalNeutralized = saved;
    modalNeutralizedNodes.push(node);
  }

  function restoreModalAncestorStyles() {
    while (modalNeutralizedNodes.length) {
      const node = modalNeutralizedNodes.pop();
      const saved = node.__rhModalNeutralized;
      delete node.__rhModalNeutralized;
      if (!saved) continue;
      Object.entries(saved).forEach(([prop, [value, priority]]) => {
        if (value) node.style.setProperty(prop, value, priority);
        else node.style.removeProperty(prop);
      });
    }
  }

  function findCharacterModalRoots() {
    return characterModalCandidateNodes().filter((node) => {
      if (isHelperElementStrict(node)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5) return false;
      if (!$("a[href*='/user/']", node) || !$("img", node)) return false;
      const text = compact(node.innerText || "", 1200);
      return text.includes("#") || /세계관|캐릭터\s*소개|제작자\s*코멘트/.test(text);
    });
  }

  function cardRenderKey(id, char, creator, options = {}) {
    return JSON.stringify({
      id,
      name: char.name || "",
      played: Boolean(char.played),
      seen: Boolean(char.seen),
      rating: Number(char.rating || 0),
      note: char.note || "",
      tags: (char.tags || []).slice(0, 8),
      userCount: Number(char.userCount || 0),
      chatCount: Number(char.chatCount || 0),
      averageChats: Number(char.averageChats || 0),
      createdAt: char.createdAt || "",
      isNew: isNewCharacter(char),
      newSectionCard: Boolean(options.newSectionCard),
      creatorName: creatorDisplayName(creator),
      creatorLookupDone: char.creatorId ? creatorLookupDone.has(char.creatorId) : false,
      creatorLookupInFlight: char.creatorId ? creatorLookupInFlight.has(char.creatorId) : false,
      creatorNote: creator.note || "",
      creatorColor: creator.color || "",
      creatorIcon: creator.icon || "",
      creatorFollowingBadge: Boolean(creator.following),
      creatorHidden: Boolean(creator.hidden),
      creatorFollowing: Boolean(creator.following),
      creatorBlocked: Boolean(creator.blocked),
      creatorRevealed: revealedCreatorCharacters.has(id)
    });
  }

  function cleanupStaleCards(currentIds, currentGridHosts, currentHosts = new Set()) {
    $$(".rh-enhanced-card").forEach((node) => {
      if (currentHosts.has(node)) return;
      if (node.contains(document.activeElement)) return;
      $(":scope > .rh-card-info", node)?.remove();
      $$(".rh-card-image-stats", node).forEach((stats) => cleanupImageStats(stats));
      $$(".rh-native-chat-hidden", node).forEach((badge) => badge.classList.remove("rh-native-chat-hidden"));
      $$(".rh-inline-new-badge", node).forEach((badge) => badge.remove());
      node.classList.remove("rh-enhanced-card", "rh-hidden-card", "rh-creator-muted", "rh-new-section-card");
      delete node.dataset.rhCharacterId;
      delete node.dataset.rhCreatorId;
    });
    $$(".rh-card-grid-host").forEach((node) => {
      if (!currentGridHosts.has(node)) node.classList.remove("rh-card-grid-host");
    });
  }

  const ICONS = {
    creator: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/><path d="M4.5 20.25a7.5 7.5 0 0 1 15 0"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 20h5v-1a4 4 0 0 0-6.3-3.3M17 20H7m10 0v-1c0-1-.2-2-.7-2.7M7 20H2v-1a4 4 0 0 1 6.3-3.3M7 20v-1c0-1 .2-2 .7-2.7m0 0a6 6 0 0 1 8.6 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>`,
    chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12c0 4.556-4.03 8.25-9 8.25a9.76 9.76 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a6 6 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/></svg>`,
    refresh: `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 sm:h-7 sm:w-7 text-white shadow-2xl" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 20v-6h-6"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 9A8 8 0 0 0 6.3 5.7L4 8"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 15a8 8 0 0 0 13.7 3.3L20 16"/></svg>`
  };

  const MENU_ICONS = {
    page: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7"/><path d="M8 7h9v9"/><path d="M5 5v14h14"/></svg>`,
    follow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg>`,
    memo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>`,
    sticker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3Z"/><path d="M19 3v4"/><path d="M21 5h-4"/></svg>`,
    block: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`
  };

  function syncCardImageStats(anchor, char, creator, options = {}) {
    // 예전 방식(네이티브 배지 innerHTML 교체)이 남긴 흔적이 있으면 먼저 원복한다.
    $$(".rh-card-image-stats", anchor).forEach((node) => {
      if (node.dataset.rhOriginalHtml) cleanupImageStats(node);
    });

    const nativeBadges = findNativeChatBadges(anchor);
    const fallbackBadge = options.newSectionCard ? findNativeChatBadge(anchor, options) : null;
    const html = renderImageStats(char, creator, options) || (options.newSectionCard ? renderNativeChatFallbackStats(fallbackBadge) : "");
    const host = findImageOverlayHost(anchor);
    let stats = host ? $(":scope > .rh-card-image-stats", host) : null;

    if (!html || !host) {
      nativeBadges.forEach((node) => node.classList.remove("rh-native-chat-hidden"));
      if (stats) cleanupImageStats(stats);
      return;
    }

    // 사이트(React) 소유 배지를 직접 수정하면 재렌더링 때마다 서로 덮어쓰는 깜빡임이 생긴다.
    // 배지는 숨기기만 하고, 통계는 항상 Helper 소유의 별도 요소에 그린다.
    nativeBadges.forEach((node) => node.classList.add("rh-native-chat-hidden"));
    if (!stats) {
      host.classList.add("rh-card-image-host");
      stats = document.createElement("div");
      stats.className = "rh-card-image-stats";
      host.append(stats);
    }
    stats.classList.toggle("rh-card-new-stats", Boolean(options.newSectionCard));
    if (stats.dataset.rhStats !== html) {
      stats.innerHTML = html;
      stats.dataset.rhStats = html;
    }
  }

  function cleanupImageStats(stats) {
    if (!stats) return;
    if (stats.dataset.rhOriginalHtml) {
      stats.innerHTML = stats.dataset.rhOriginalHtml;
      delete stats.dataset.rhOriginalHtml;
      delete stats.dataset.rhStats;
      stats.classList.remove("rh-card-image-stats", "rh-card-native-stats", "rh-card-new-stats");
      return;
    }
    stats.remove();
  }

  function findNativeChatBadge(anchor, options = {}) {
    const candidates = findNativeChatBadges(anchor);
    if (!candidates.length) return null;
    const anchorRect = anchor.getBoundingClientRect?.();
    const scored = candidates.map((node) => {
      const className = String(node.className || "");
      const rect = node.getBoundingClientRect?.();
      const bottomRightClass = className.includes("bottom-") && className.includes("right-");
      const topLeftClass = className.includes("top-") && className.includes("left-");
      let score = bottomRightClass ? 0 : 20;
      if (options.newSectionCard && topLeftClass) score -= 8;
      if (anchorRect && rect) {
        const bottomRightDistance = Math.abs(anchorRect.right - rect.right) + Math.abs(anchorRect.bottom - rect.bottom);
        const topLeftDistance = Math.abs(rect.left - anchorRect.left) + Math.abs(rect.top - anchorRect.top);
        score += Math.min(bottomRightDistance, topLeftDistance) / 100;
      }
      return { node, score };
    });
    return scored.sort((a, b) => a.score - b.score)[0]?.node || null;
  }

  function findNativeChatBadges(anchor) {
    const defaultSelectors = [
      "div[class~='absolute'][class~='bottom-1'][class~='right-1']",
      "div[class*='bottom-1'][class*='right-1']",
      // 새로 나온 캐릭터 카드의 좌상단 대화수 배지 (aspect 컨테이너 안이라 absolute 클래스가 없음)
      "div[class*='inline-flex'][class*='bg-opacity-50']"
    ];
    const allAbsoluteBadges = $$("div[class*='absolute']", anchor)
      .filter((node) => node.querySelector("svg") && node.querySelector("span"));
    const selectorBadges = defaultSelectors.flatMap((selector) => $$(selector, anchor));
    return uniqueBy([...selectorBadges, ...allAbsoluteBadges], (node) => node)
      .filter((node) => !node.closest(".rh-card-info"))
      .filter((node) => !node.classList.contains("rh-card-image-stats"))
      .filter((node) => !node.querySelector("img"))
      .filter((node) => /\d/.test(node.textContent || ""));
  }

  function findNewSectionContainers() {
    const headings = $$("h1, h2, h3, h4, [role='heading']").filter((node) => {
      if (isHelperElement(node)) return false;
      const text = compact(node.innerText || node.textContent || "", 40);
      return /새로\s*나온\s*캐릭터/.test(text);
    });
    return uniqueBy(
      headings.map((heading) => heading.closest("section") || heading.parentElement?.parentElement || heading.parentElement || heading),
      (node) => node
    );
  }

  function syncNativeNewBadge(anchor, char, options = {}) {
    const existing = $(".rh-inline-new-badge", anchor);
    const shouldShow = isNewCharacter(char) && !options.newSectionCard;
    if (!shouldShow) {
      existing?.remove();
      return;
    }
    const nameNode = findNativeNameElement(anchor, char);
    if (!nameNode) {
      existing?.remove();
      return;
    }
    if (existing && existing.parentElement === nameNode) return;
    existing?.remove();
    const badge = document.createElement("span");
    badge.className = "rh-inline-new-badge";
    badge.textContent = "NEW";
    nameNode.prepend(badge);
  }

  function findNativeNameElement(anchor, char) {
    const name = String(char?.name || "").trim();
    if (!name) return null;
    const candidates = $$("h1, h2, h3, h4, p, span, div", anchor)
      .filter((node) => !isHelperElement(node))
      .filter((node) => !node.querySelector("img, svg, button, a"))
      .filter((node) => {
        const text = compact(node.textContent || "", 80).replace(/^NEW\s*/i, "");
        if (!text || text.includes("\n")) return false;
        if (text.includes("#")) return false;
        if (/^[\d.]+(천|만)?\s+/.test(text)) return false;
        return text === name || text.startsWith(`${name} `) || text.startsWith(name);
      });
    return candidates
      .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0] || null;
  }

  function findImageOverlayHost(anchor) {
    const image = $("img", anchor);
    let node = image?.parentElement || null;
    while (node && node !== anchor) {
      const className = String(node.className || "");
      // aspect-w-*/aspect-h-* 컨테이너는 직접 자식을 강제로 absolute 풀사이즈로 만들기 때문에
      // 오버레이 host로 쓸 수 없다 — 그 위의 relative 조상을 쓴다.
      if (className.includes("relative") && !className.includes("aspect-")) return node;
      node = node.parentElement;
    }
    if (image?.parentElement) return image.parentElement;
    return anchor;
  }

  function renderImageStats(char, creator, options = {}) {
    // 새 섹션은 API 데이터가 확보된 상태이므로 0도 생략하지 않고 표시한다.
    const showZero = Boolean(options.newSectionCard) && char.userCount !== undefined && char.chatCount !== undefined;
    const statItems = [
      (char.userCount || showZero) ? `${ICONS.user}<span>${esc(formatCount(char.userCount || 0))}</span>` : "",
      (char.chatCount || showZero) ? `${ICONS.chat}<span>${esc(formatCount(char.chatCount || 0))}</span>` : ""
    ].filter(Boolean);
    const creatorLabel = options.newSectionCard ? creatorDisplayName(creator) : "";
    if (!statItems.length && !char.averageChats && !creatorLabel) return "";
    const line = [
      statItems.length ? `<span class="rh-stat-pair" title="유저 수 / 채팅 수">${statItems.join("")}</span>` : "",
      char.averageChats ? `<span class="rh-stat-average" title="1인당 평균 채팅">평균 ${esc(char.averageChats)}</span>` : ""
    ].filter(Boolean).join("");
    return `
      ${line ? `<span class="rh-stat-line">${line}</span>` : ""}
      ${creatorLabel ? `<span class="rh-stat-creator" title="제작자">${ICONS.creator}<span>${creatorFollowHeart(creator)}${esc(creator.icon || "")} ${esc(creatorLabel)}</span></span>` : ""}
    `;
  }

  function renderNativeChatFallbackStats(nativeStats) {
    const chatCount = compact(nativeStats?.innerText || nativeStats?.textContent || "", 20);
    if (!chatCount) return "";
    return `<span class="rh-stat-line"><span class="rh-stat-pair" title="채팅 수">${ICONS.chat}<span>${esc(chatCount)}</span></span></span>`;
  }

  function isNewCharacter(char) {
    const created = parseRofanDate(char?.createdAt);
    if (!Number.isFinite(created)) return false;
    const age = Date.now() - created;
    const createdDate = new Date(created);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const createdStart = new Date(createdDate);
    createdStart.setHours(0, 0, 0, 0);
    const dayAge = Math.floor((todayStart.getTime() - createdStart.getTime()) / (24 * 60 * 60 * 1000));
    return (age >= 0 && age <= 3 * 24 * 60 * 60 * 1000) || (dayAge >= 0 && dayAge <= 3);
  }

  function parseRofanDate(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return NaN;
    const normalized = raw
      .replace(/^제작일\s*[:：]\s*/, "")
      .replace(/\./g, "-")
      .replace(/\//g, "-");
    const full = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (full) {
      return new Date(
        Number(full[1]),
        Number(full[2]) - 1,
        Number(full[3]),
        Number(full[4] || 0),
        Number(full[5] || 0),
        Number(full[6] || 0)
      ).getTime();
    }
    const short = normalized.match(/^(\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (short) {
      return new Date(
        2000 + Number(short[1]),
        Number(short[2]) - 1,
        Number(short[3]),
        Number(short[4] || 0),
        Number(short[5] || 0),
        Number(short[6] || 0)
      ).getTime();
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function renderCardInfo(id, char, creator, anchor, options = {}) {
    const badges = [];
    if (char.played) badges.push(["playing", "PLAYING"]);
    // 팔로우 제작자는 제작자 이름 옆 하트로 이미 표시되므로 별도 배지는 두지 않는다

    // 카드 자체(사이트 h3 등)에 이름이 이미 보이면 중복 표시하지 않는다.
    // card-info가 앵커 안에 들어가므로 innerText 검사 대신 Helper 요소를 제외한
    // 네이티브 이름 노드 존재 여부로 판정한다 (자기 자신을 근거로 삼는 것 방지).
    const nameVisibleOnCard = Boolean(char.name) && Boolean(findNativeNameElement(anchor, char));
    const showHelperName = !nameVisibleOnCard;
    const name = char.name || "";
    // 제작자(크리에이터) 페이지에서는 어차피 모든 카드가 같은 제작자이므로 제작자 줄을 숨긴다
    const onCreatorPage = Boolean(currentProfileCreatorId());
    const creatorLabel = onCreatorPage ? "" : creatorDisplayName(creator);
    // 이름 미확보 상태에서 조회 중이거나 아직 완료 안 됐으면(재시도 예정 포함) "로딩중" 유지
    const creatorPending = !onCreatorPage && char.creatorId && !creatorLabel && !creatorLookupDone.has(char.creatorId);
    const creatorLine = creatorLabel || creatorPending;
    return `
      ${showHelperName ? (name
        ? `<div class="rh-card-name">${esc(name)}</div>`
        : `<div class="rh-card-name rh-creator-pending">로딩중...</div>`) : ""}
      ${creatorLine || char.rating ? `
        <div class="rh-card-creator">
          ${creatorLine ? `
            <button type="button" class="rh-creator-menu-trigger" data-rh-creator-id="${esc(char.creatorId || "")}" data-rh-creator-name="${esc(creatorLabel || "로딩중")}" style="color:${esc(creator.color || "")}">
              ${ICONS.creator}<span class="rh-creator-name${creatorLabel ? "" : " rh-creator-pending"}">${creatorFollowHeart(creator)}${esc(creator.icon || "")} ${esc(creatorLabel || "로딩중...")}</span>
            </button>` : ""}
          ${char.rating ? `<span class="rh-rating">${"★".repeat(char.rating)}</span>` : ""}
        </div>` : ""}
      ${badges.length ? `<div class="rh-badges">${badges.map(([kind, label]) => `<span data-rh-badge="${kind}">${esc(label)}</span>`).join("")}</div>` : ""}
      <div class="rh-card-notes">
        ${char.note ? `<small>${esc(compact(char.note, 90))}</small>` : ""}
        ${creator.note ? `<small>제작자 메모: ${esc(compact(creator.note, 70))}</small>` : ""}
      </div>
      <div class="rh-inline-editor" hidden>
        <label>별점
          <select data-rh-edit="rating" data-id="${esc(id)}">
            ${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${Number(char.rating || 0) === n ? "selected" : ""}>${n ? "★".repeat(n) : "없음"}</option>`).join("")}
          </select>
        </label>
        <label>메모
          <textarea data-rh-edit="note" data-id="${esc(id)}" placeholder="개인 메모">${esc(char.note || "")}</textarea>
        </label>
      </div>
    `;
  }

  function creatorFollowHeart(creator) {
    return creator?.following ? `<span class="rh-creator-follow-heart" title="팔로우 중">♥</span>` : "";
  }

  function showCreatorMenu(trigger) {
    const id = trigger.dataset.rhCreatorId;
    if (!id) return;
    const creator = state.creators[id] || {};
    const label = creatorDisplayName(creator) || trigger.dataset.rhCreatorName || "제작자";
    selectedCreatorId = id;
    if (!creatorMenu) {
      creatorMenu = document.createElement("div");
      creatorMenu.id = "rofan-helper-creator-menu";
      document.documentElement.append(creatorMenu);
    }
    creatorMenu.dataset.creatorId = id;
    creatorMenu.innerHTML = renderCreatorMenu(id, creator, label);
    creatorMenu.hidden = false;
    positionCreatorMenu(trigger);
    refreshCreatorRelation(id).catch(() => {});
  }

  function renderCreatorMenu(id, creator, label) {
    const hidden = Boolean(creator.hidden);
    const following = Boolean(creator.following);
    const blocked = Boolean(creator.blocked);
    return `
      <div class="rh-creator-menu-head">
        ${ICONS.creator}<strong>${creatorFollowHeart(creator)}${esc(label)}</strong>
      </div>
      <button type="button" data-rh-creator-action="page" data-id="${esc(id)}">${MENU_ICONS.page}<span>제작자 페이지 이동</span></button>
      <button type="button" data-rh-creator-action="follow" data-id="${esc(id)}">${MENU_ICONS.follow}<span>${following ? "제작자 팔로우 해제" : "제작자 팔로우"}</span></button>
      <button type="button" data-rh-creator-action="memo" data-id="${esc(id)}">${MENU_ICONS.memo}<span>제작자 메모</span></button>
      <label class="rh-creator-menu-note" hidden>
        <textarea data-rh-creator-note="${esc(id)}" placeholder="제작자 메모">${esc(creator.note || "")}</textarea>
      </label>
      <button type="button" data-rh-creator-action="block" data-id="${esc(id)}">${MENU_ICONS.block}<span>${blocked ? "제작자 차단 해제" : "제작자 차단하기"}</span></button>
      <button type="button" data-rh-creator-action="hide" data-id="${esc(id)}">${MENU_ICONS.eye}<span>${hidden ? "해당 제작자 캐릭터 가리기 해제" : "해당 제작자 캐릭터 가리기"}</span></button>
    `;
  }

  function positionCreatorMenu(trigger) {
    if (!creatorMenu) return;
    const rect = trigger.getBoundingClientRect();
    const menuRect = creatorMenu.getBoundingClientRect();
    const gap = 8;
    const left = window.scrollX + Math.min(window.innerWidth - menuRect.width - 12, Math.max(12, rect.left));
    const top = window.scrollY + Math.min(window.innerHeight - menuRect.height - 12, Math.max(12, rect.bottom + gap));
    creatorMenu.style.left = `${left}px`;
    creatorMenu.style.top = `${top}px`;
  }

  function closeCreatorMenu() {
    if (creatorMenu) creatorMenu.hidden = true;
  }

  function creatorUrl(id) {
    return `/user/${encodeURIComponent(id)}`;
  }

  function openCreatorActionPage(id, message) {
    if (!id) return;
    showToast(message);
    const opened = window.open(creatorUrl(id), "_blank", "noopener");
    if (!opened) location.href = creatorUrl(id);
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`);
    return data;
  }

  const creatorRelationCheckedAt = new Map();

  async function refreshCreatorRelation(id, force = false) {
    if (!id) return;
    // 최근 5분 내 확인했으면 다시 호출하지 않는다 (불필요한 API 호출 절감)
    if (!force && Date.now() - (creatorRelationCheckedAt.get(id) || 0) < 5 * 60 * 1000) return;
    creatorRelationCheckedAt.set(id, Date.now());
    const userId = currentUserId();
    const patch = {};
    try {
      const follows = await postJson("/api/follow/GetFollows", { userId: userId || null, creatorId: id });
      patch.following = Boolean(follows.isFollowing);
      patch.followsCount = toNumber(follows.followsCount);
      patch.notify = Boolean(follows.isFollowing && follows.notify);
    } catch {}
    try {
      const blockData = await postJson("/api/block/GetBlockList", { type: "user_id" });
      const blocks = Array.isArray(blockData.blocks) ? blockData.blocks : [];
      patch.blocked = blocks.some((item) => item?.target_id === id || item?.targetId === id);
    } catch {}
    if (!Object.keys(patch).length) return;
    ensureCreator(id, patch);
    await saveState();
    if (creatorMenu && !creatorMenu.hidden && creatorMenu.dataset.creatorId === id) {
      const creator = state.creators[id] || {};
      creatorMenu.innerHTML = renderCreatorMenu(id, creator, creatorDisplayName(creator) || "제작자");
    }
    applyEnhancements({ preserveEditors: true });
  }

  async function toggleCreatorFollowFromMenu(id) {
    if (!id) return;
    const userId = currentUserId();
    if (!userId) {
      showToast("로그인 정보가 확인되지 않아 제작자 페이지에서 팔로우해주세요.");
      openCreatorActionPage(id, "제작자 페이지에서 팔로우 버튼을 눌러주세요.");
      return;
    }
    try {
      await postJson("/api/follow/UpdateFollow", { userId, creatorId: id });
      await refreshCreatorRelation(id, true);
      showToast(state.creators[id]?.following ? "제작자를 팔로우했어요." : "제작자 팔로우를 해제했어요.");
    } catch {
      showToast("팔로우 변경에 실패했어요. 제작자 페이지에서 다시 시도해주세요.");
    }
  }

  async function toggleCreatorBlockFromMenu(id) {
    if (!id) return;
    const blocked = Boolean(state.creators[id]?.blocked);
    try {
      await postJson(blocked ? "/api/block/DeleteBlock" : "/api/block/CreateBlock", { type: "user_id", targetId: id });
      ensureCreator(id, { blocked: !blocked });
      await saveState();
      showToast(blocked ? "제작자 차단을 해제했어요." : "제작자를 차단했어요.");
      closeCreatorMenu();
      applyEnhancements({ preserveEditors: true });
    } catch {
      showToast("차단 변경에 실패했어요. 제작자 페이지에서 다시 시도해주세요.");
    }
  }

  async function toggleCreatorHiddenFromMenu(id) {
    if (!id) return;
    const creator = state.creators[id] || {};
    ensureCreator(id, { hidden: !creator.hidden });
    revealedCreatorCharacters.clear();
    await saveState();
    closeCreatorMenu();
    applyEnhancements({ preserveEditors: true });
    if (!panel.hidden && panel.dataset.tab === "creator") renderPanel("creator");
  }

  document.addEventListener("click", async (event) => {
    // 스티커 클릭 = ... 메뉴 열기 (스티커가 메뉴 버튼의 외형이므로)
    const stickerMenuHit = event.target.closest(".rh-sticker-menu-hit");
    if (stickerMenuHit) {
      event.preventDefault();
      event.stopPropagation();
      const stickerProxy = stickerMenuHit.closest(".rh-room-sticker-overlay.rh-sticker-menu-proxy");
      const item = stickerProxy.closest("[data-rh-room-decorated]") || stickerProxy.parentElement;
      $(".rh-room-more-button", item)?.click();
      return;
    }

    const roomMoreButton = event.target.closest(".rh-room-more-button");
    if (roomMoreButton) {
      activeRoomMenuId = roomMoreButton.dataset.rhRoomMenuId || "";
      setTimeout(() => enhanceChatListMenus(), 80);
      setTimeout(() => enhanceChatListMenus(), 240);
      setTimeout(() => enhanceChatListMenus(), 520);
    }

    const roomMenuAction = event.target.closest("[data-rh-room-menu-action]");
    if (roomMenuAction) {
      event.preventDefault();
      event.stopPropagation();
      const id = roomMenuAction.dataset.id || activeRoomMenuId;
      closeSiteRoomMenu();
      if (roomMenuAction.dataset.rhRoomMenuAction === "memo") showRoomMemoDialog(id);
      if (roomMenuAction.dataset.rhRoomMenuAction === "sticker") enterStickerEdit(id);
      return;
    }

    const roomDialogCancel = event.target.closest("[data-rh-room-dialog-cancel]");
    if (roomDialogCancel) {
      event.preventDefault();
      event.stopPropagation();
      closeRoomDialog();
      return;
    }

    const roomDialogSave = event.target.closest("[data-rh-room-dialog-save]");
    if (roomDialogSave) {
      event.preventDefault();
      event.stopPropagation();
      await saveRoomDialog();
      return;
    }

    const stickerPreset = event.target.closest("[data-rh-sticker-preset]");
    if (stickerPreset) {
      event.preventDefault();
      event.stopPropagation();
      if (!stickerEdit) return;
      stickerEdit.draft.kind = stickerPreset.dataset.rhStickerPreset;
      stickerEdit.draft.image = "";
      applyStickerDraft();
      return;
    }

    const stickerAction = event.target.closest("[data-rh-sticker-action]");
    if (stickerAction) {
      event.preventDefault();
      event.stopPropagation();
      const action = stickerAction.dataset.rhStickerAction;
      if (action === "cancel") exitStickerEdit(false);
      if (action === "done") await exitStickerEdit(true);
      if (action === "remove") await removeStickerFromEdit();
      return;
    }

    const roomNoteOpen = event.target.closest("[data-rh-room-note-open]");
    if (roomNoteOpen) {
      event.preventDefault();
      event.stopPropagation();
      showRoomMemoDialog(roomNoteOpen.dataset.rhRoomNoteOpen);
      return;
    }

    const roomEditorClose = event.target.closest("[data-rh-room-editor-close]");
    if (roomEditorClose) {
      event.preventDefault();
      event.stopPropagation();
      closeRoomEditor();
      return;
    }

    const roomOpen = event.target.closest("[data-rh-room-open]");
    if (roomOpen) {
      event.preventDefault();
      event.stopPropagation();
      location.href = `/chat/${encodeURIComponent(roomOpen.dataset.rhRoomOpen)}`;
      return;
    }

    const imageClear = event.target.closest("[data-rh-room-image-clear]");
    if (imageClear) {
      event.preventDefault();
      event.stopPropagation();
      const id = imageClear.dataset.id;
      const field = imageClear.dataset.rhRoomImageClear;
      ensureRoom(id, { [field]: "" });
      await saveState();
      showRoomEditor(id, roomEditor);
      applyEnhancements({ preserveEditors: true });
      return;
    }

    const refreshAssetButton = event.target.closest(".rh-modal-refresh-button");
    if (refreshAssetButton) {
      event.preventDefault();
      event.stopPropagation();
      await resetModalAssetsToFirst(refreshAssetButton);
      setTimeout(() => enhanceCharacterModals(), 120);
      setTimeout(() => enhanceCharacterModals(), 420);
      return;
    }

    if (event.target.closest(".rh-modal-asset-strip button")) {
      scheduleModalAssetNavigationTrack(event);
      setTimeout(() => enhanceCharacterModals(), 120);
      setTimeout(() => enhanceCharacterModals(), 420);
      setTimeout(() => enhanceCharacterModals(), 900);
    }

    const creatorMenuAction = event.target.closest("[data-rh-creator-action]");
    if (creatorMenuAction) {
      event.preventDefault();
      event.stopPropagation();
      const id = creatorMenuAction.dataset.id;
      const action = creatorMenuAction.dataset.rhCreatorAction;
      if (action === "page") location.href = creatorUrl(id);
      if (action === "follow") await toggleCreatorFollowFromMenu(id);
      if (action === "block") await toggleCreatorBlockFromMenu(id);
      if (action === "memo") {
        const note = $(".rh-creator-menu-note", creatorMenu);
        if (note) {
          note.hidden = !note.hidden;
          if (!note.hidden) $("textarea", note)?.focus();
        }
      }
      if (action === "hide") await toggleCreatorHiddenFromMenu(id);
      return;
    }

    const creatorTrigger = event.target.closest(".rh-creator-menu-trigger");
    if (creatorTrigger) {
      event.preventDefault();
      event.stopPropagation();
      const id = creatorTrigger.dataset.rhCreatorId;
      if (creatorMenu && !creatorMenu.hidden && creatorMenu.dataset.creatorId === id) {
        closeCreatorMenu();
        return;
      }
      showCreatorMenu(creatorTrigger);
      return;
    }

    if (event.target.closest("#rofan-helper-creator-menu")) return;
    if (event.target.closest("#rofan-helper-room-dialog")) return;
    if (event.target.closest("#rofan-helper-room-editor")) return;
    closeCreatorMenu();
    closeRoomEditor();

    const mutedCard = event.target.closest(".rh-creator-muted");
    if (mutedCard?.dataset.rhCharacterId) {
      event.preventDefault();
      event.stopPropagation();
      revealedCreatorCharacters.add(mutedCard.dataset.rhCharacterId);
      applyEnhancements({ preserveEditors: true });
      return;
    }

    const button = event.target.closest("[data-rh-card-action]");
    const startChat = event.target.closest("button, a");
    if (!button && startChat && /대화\s*시작|Start\s*Chat|채팅\s*시작/i.test(startChat.innerText || "")) {
      const id = currentCharacterId();
      if (id) {
        markPlayed(id);
        await saveState();
      }
      return;
    }
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = button.dataset.id;
    const action = button.dataset.rhCardAction;
    if (action === "copy") copyText(`${location.origin}/character/${id}`);
    if (action === "hide") {
      const bot = botById(id);
      ensureCharacter(id, { ...(bot ? botToCharacterPatch(bot) : {}), hidden: !state.characters[id]?.hidden });
      await saveState();
      applyEnhancements({ preserveEditors: true });
    }
    if (action === "edit") {
      const card = button.closest(".rh-enhanced-card");
      const editor = card ? $(".rh-inline-editor", card) : null;
      if (editor) editor.hidden = !editor.hidden;
      selectedCharacterId = id;
    }
  }, true);

  document.addEventListener("input", debounce(async (event) => {
    const roomNoteField = event.target.closest("[data-rh-room-note-input]");
    if (roomNoteField) {
      const id = roomNoteField.dataset.rhRoomNoteInput;
      if (!id) return;
      ensureRoom(id, { note: roomNoteField.value });
      await saveState();
      decorateChatListRooms();
      if (!panel.hidden && panel.dataset.tab === "chat") renderPanel("chat");
      return;
    }

    const creatorNoteField = event.target.closest("[data-rh-creator-note]");
    if (creatorNoteField) {
      const id = creatorNoteField.dataset.rhCreatorNote;
      if (!id) return;
      ensureCreator(id, { note: creatorNoteField.value });
      await saveState();
      if (!panel.hidden && panel.dataset.tab === "creator") renderPanel("creator");
      return;
    }

    const field = event.target.dataset.rhEdit;
    if (!field) return;
    const id = event.target.dataset.id;
    if (!id) return;
    const bot = botById(id);
    const base = bot ? botToCharacterPatch(bot) : {};
    if (field === "note") ensureCharacter(id, { ...base, note: event.target.value });
    if (field === "rating") ensureCharacter(id, { ...base, rating: Number(event.target.value) });
    await saveState();
  }, 250), true);

  document.addEventListener("change", async (event) => {
    const stickerImage = event.target.closest("[data-rh-sticker-image]");
    if (stickerImage) {
      const file = stickerImage.files?.[0];
      if (!file || !stickerEdit) return;
      try {
        stickerEdit.draft.image = await fileToStickerImage(file, 280);
        applyStickerDraft();
      } catch {
        showToast("스티커 이미지 저장에 실패했어요.");
      } finally {
        stickerImage.value = "";
      }
      return;
    }

    const imageInput = event.target.closest("[data-rh-room-image]");
    if (!imageInput) return;
    const file = imageInput.files?.[0];
    if (!file) return;
    try {
      await storeRoomImageFromFile(imageInput.dataset.id, imageInput.dataset.rhRoomImage, file);
      showToast("대화방 이미지를 저장했어요.");
    } catch {
      showToast("이미지 저장에 실패했어요.");
    } finally {
      imageInput.value = "";
    }
  }, true);

  async function importChatList() {
    if (!isChatListPage()) {
      showToast("https://rofan.ai/chat-list 페이지에서만 수집할 수 있어요.");
      return;
    }
    const result = await collectChatListCurrentPage();
    showToast(result.rooms || result.characters ? `대화방 ${result.rooms}개, 캐릭터 ${result.characters}개를 수집했어요.` : "가져올 대화방을 찾지 못했어요.");
  }

  async function collectChatListCurrentPage() {
    const bots = readPageBots();
    const rooms = collectChatListRoomsFromDom();
    const ids = new Set(bots.map((bot) => bot.bot_id).filter(Boolean));
    $$("a[href*='/character/']").forEach((anchor) => {
      const id = anchor.href.match(UUID_RE)?.[0];
      if (id) ids.add(id);
    });
    rooms.forEach((room) => {
      ensureRoom(room.id, room);
      if (room.characterId) ids.add(room.characterId);
    });

    let count = 0;
    ids.forEach((id) => {
      const bot = botById(id) || bots.find((item) => item.bot_id === id);
      if (bot) {
        const patch = botToCharacterPatch(bot);
        updateStoredCharacterIfNeeded(bot);
        ensureCharacter(id, { ...patch, played: true, lastPlayedAt: nowIso() });
        if (patch.creatorId) ensureCreator(patch.creatorId, creatorPatchFromBot(bot));
      } else {
        ensureCharacter(id, { played: true, lastPlayedAt: nowIso() });
      }
      markPlayed(id);
      count += 1;
    });

    await saveState();
    applyEnhancements({ preserveEditors: true });
    if (!panel.hidden) renderPanel(panel.dataset.tab || "home");
    return { rooms: rooms.length, characters: count };
  }

  async function startFullChatListCollection() {
    const ok = window.confirm("대화한 캐릭터가 많으면 수집이 오래걸릴 수 있어요.\n중간에 수집을 중단하는 경우 이어서 수집이 불가능합니다.\n\n수집을 진행할까요?");
    if (!ok) return;
    state.settings.chatListCollection = {
      active: true,
      page: 1,
      rooms: 0,
      characters: 0,
      startedAt: nowIso(),
      lastCollectedAt: "",
      visited: []
    };
    await saveState();
    location.href = `${location.origin}/chat-list?page=1`;
  }

  function scheduleChatListCollectionStep() {
    const collection = state.settings.chatListCollection || {};
    if (!collection.active || !isChatListPage() || chatListCollectRunning) return;
    clearTimeout(chatListCollectTimer);
    chatListCollectTimer = setTimeout(() => {
      runChatListCollectionStep().catch(() => finishChatListCollection("수집 중 오류가 발생해 멈췄어요."));
    }, 900);
  }

  async function runChatListCollectionStep() {
    const collection = state.settings.chatListCollection || {};
    if (!collection.active || chatListCollectRunning) return;
    chatListCollectRunning = true;
    try {
      const pageKey = `${location.pathname}${location.search}#${collection.page || 1}`;
      const result = await collectChatListCurrentPage();
      const current = state.settings.chatListCollection;
      current.rooms = Number(current.rooms || 0) + Number(result.rooms || 0);
      current.characters = Number(current.characters || 0) + Number(result.characters || 0);
      current.visited = unique([...(current.visited || []), pageKey]).slice(-500);
      current.lastCollectedAt = nowIso();
      await saveState();
      if (!panel.hidden && panel.dataset.tab === "settings") renderPanel("settings");

      const next = findChatListNextControl();
      if (!next || Number(current.page || 1) >= 500) {
        await finishChatListCollection(`대화목록 수집 완료: 대화방 ${current.rooms || 0}개`);
        return;
      }
      current.page = Number(current.page || 1) + 1;
      await saveState();
      showToast(`${current.page}페이지로 이동하며 수집 중...`);
      goToNextChatListPage(next);
    } finally {
      chatListCollectRunning = false;
    }
  }

  async function finishChatListCollection(message) {
    state.settings.chatListCollection = {
      ...(state.settings.chatListCollection || {}),
      active: false,
      lastCollectedAt: nowIso()
    };
    await saveState();
    if (!panel.hidden && panel.dataset.tab === "settings") renderPanel("settings");
    showToast(message);
  }

  function findChatListNextControl() {
    const controls = $$("a, button")
      .filter((node) => isVisible(node) && !isHelperElement(node) && !isDisabledControl(node))
      .map((node) => ({ node, score: nextControlScore(node) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.node.getBoundingClientRect().top - a.node.getBoundingClientRect().top);
    return controls[0]?.node || null;
  }

  function nextControlScore(node) {
    const label = compact(`${node.innerText || ""} ${node.getAttribute("aria-label") || ""} ${node.title || ""}`, 80);
    const rect = node.getBoundingClientRect();
    let score = 0;
    if (/다음|next/i.test(label)) score += 80;
    if (/[›»>]/.test(label.trim())) score += 60;
    const pathText = $$("path", node).map((path) => path.getAttribute("d") || "").join(" ");
    if (/M9\s*5l7\s*7-7\s*7|m9\s*5l7\s*7-7\s*7|7-7-7-7/i.test(pathText)) score += 55;
    if (rect.top > window.innerHeight * 0.45) score += 10;
    if (rect.right > window.innerWidth * 0.5) score += 8;
    if (/이전|prev|previous/i.test(label)) score -= 100;
    return score;
  }

  function isDisabledControl(node) {
    if (node.disabled || node.getAttribute("aria-disabled") === "true") return true;
    const className = String(node.className || "");
    if (/disabled|cursor-not-allowed|opacity-40|opacity-50|pointer-events-none/i.test(className)) return true;
    const style = getComputedStyle(node);
    return style.pointerEvents === "none" || Number(style.opacity || 1) < 0.45;
  }

  function goToNextChatListPage(control) {
    const href = control.tagName === "A" ? control.href : "";
    if (href) {
      location.href = href;
      return;
    }
    control.click();
    setTimeout(() => scheduleChatListCollectionStep(), 1200);
  }

  function isChatListPage() {
    return /^\/(?:en\/|ja\/)?chat-list\/?$/i.test(location.pathname);
  }

  function collectChatListRoomsFromDom() {
    if (!isChatListPage()) return [];
    const rooms = [];
    $$("a[href*='/chat/']").forEach((anchor) => {
      const id = anchor.href.match(UUID_RE)?.[0];
      if (!id) return;
      const item = chatListItemForAnchor(anchor);
      // ... 메뉴가 열려 있으면 메뉴 텍스트가 innerText에 섞여 제목/이름 추론이 오염된다 — 수집 건너뜀
      if (item && hasOpenRoomMenu(item)) return;
      const lines = textLines(item || anchor);
      const pair = inferRoomPair(lines);
      const characterLink = $("a[href*='/character/']", item || anchor);
      const characterId = characterLink?.href?.match(UUID_RE)?.[0] || "";
      const image = $("img", item || anchor)?.currentSrc || $("img", item || anchor)?.src || "";
      const title = inferRoomTitle(lines, anchor);
      rooms.push({
        id,
        url: `/chat/${id}`,
        title,
        characterId,
        characterName: pair.characterName || inferCharacterNameFromLines(lines),
        characterImage: image,
        personaName: pair.personaName,
        folderName: inferFolderName(item || anchor),
        source: "dom",
        lastCollectedAt: nowIso()
      });
    });
    return uniqueBy(rooms, (room) => room.id);
  }

  function chatListItemForAnchor(anchor) {
    const preferred = anchor.closest("li, article, [role='listitem']");
    if (preferred) return preferred;
    let node = anchor;
    for (let depth = 0; depth < 5 && node?.parentElement; depth += 1) {
      node = node.parentElement;
      const text = compact(node.innerText, 500);
      if (text.length > 20 && text.length < 900 && $("a[href*='/chat/']", node)) return node;
    }
    return anchor;
  }

  function textLines(node) {
    return String(node?.innerText || node?.textContent || "")
      .split(/\n+/)
      .map((line) => compact(line, 80))
      .filter(Boolean)
      .filter((line) => !/^(메모|이미지|숨김|링크|삭제|수정)$/i.test(line))
      .filter((line) => !/^R\+|^v\d+\./i.test(line));
  }

  function inferRoomTitle(lines, anchor) {
    const anchorText = compact(anchor?.innerText || "", 80);
    const candidates = [anchorText, ...lines]
      .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith("#"))
      .filter((line) => !/^\d+(\.\d+)?(천|만)?$/.test(line))
      .filter((line) => !/\s+x\s+|×/.test(line));
    return candidates[0] || "대화방";
  }

  function inferRoomPair(lines) {
    const pairLine = lines.find((line) => /\s+x\s+|×/.test(line));
    if (!pairLine) return {};
    const [characterName, personaName] = pairLine.split(/\s+x\s+|×/i).map((part) => compact(part, 36));
    return { characterName: characterName || "", personaName: personaName || "" };
  }

  function inferCharacterNameFromLines(lines) {
    return lines
      .filter((line) => !line.startsWith("#"))
      .filter((line) => !/\s+x\s+|×/.test(line))
      .filter((line) => !/폴더|folder|최근|대화|채팅/i.test(line))
      .find((line) => line.length <= 36) || "";
  }

  function inferFolderName(node) {
    const candidates = [];
    let current = node;
    for (let depth = 0; depth < 5 && current?.previousElementSibling; depth += 1) {
      current = current.previousElementSibling;
      if (/^(H[1-6]|SECTION)$/i.test(current.tagName || "")) candidates.push(...textLines(current));
    }
    return candidates.find((line) => line.length <= 28 && !line.startsWith("#")) || "";
  }

  function roomPairLabel(room) {
    return [room.characterName, room.personaName].filter(Boolean).join(" x ");
  }

  function showToast(message) {
    let toast = $("#rofan-helper-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "rofan-helper-toast";
      document.documentElement.append(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function enhanceChatList() {
    const roomId = currentRoomId();
    if (isChatListPage()) {
      let changed = false;
      collectChatListRoomsFromDom().forEach((room) => {
        const before = { ...(state.rooms[room.id] || {}) };
        ensureRoom(room.id, room);
        if (roomChanged(before, state.rooms[room.id])) changed = true;
      });
      decorateChatListRooms();
      enhanceChatListMenus();
      scheduleChatListCollectionStep();
      if (changed) scheduleHookStateSave();
      return;
    }

    if (!looksLikeChatPage()) return;
    ensureRoom(roomId, { ...collectCurrentChatRoomPatch(), lastSeenAt: nowIso() });
  }

  // 대화목록 스티커/메모 전용 빠른 재장식 (페이지 넘김 시 지연 없이 갱신)
  let chatListDecorateTimer;
  function scheduleChatListDecorate() {
    if (!isChatListPage()) return;
    clearTimeout(chatListDecorateTimer);
    chatListDecorateTimer = setTimeout(() => {
      if (!isChatListPage() || stickerEdit) return;
      // 이전 페이지에서 남은 스티커/메모 중 현재 방과 무관한 것 즉시 제거
      cleanupStaleChatListDecorations();
      decorateChatListRooms();
      enhanceChatListMenus();
    }, 90);
  }

  // 카드 자리는 재사용됐는데 방 id가 바뀐 경우, 이전 스티커/메모 잔상을 걷어낸다
  function cleanupStaleChatListDecorations() {
    $$("[data-rh-room-decorated]").forEach((item) => {
      const anchor = $("a[href*='/chat/']", item);
      const currentId = anchor?.href?.match(UUID_RE)?.[0] || "";
      if (currentId && item.dataset.rhRoomDecorated !== currentId) {
        $$(".rh-room-note-line, .rh-room-note-card, .rh-room-sticker-overlay", item).forEach((n) => n.remove());
        $$(".rh-room-more-button.rh-room-sticker-button", item).forEach((b) => b.classList.remove("rh-room-sticker-button"));
        delete item.dataset.rhRoomDecorated;
      }
    });
  }

  // 사이트 ... 드롭다운이 열려 있는지 (백드롭 div.fixed.inset-0가 아이템 안에 생긴다)
  function hasOpenRoomMenu(item) {
    return Boolean($$("div[class*='fixed'][class*='inset-0']", item).find((node) => !isHelperElement(node)));
  }

  function decorateChatListRooms() {
    $$("a[href*='/chat/']").forEach((anchor) => {
      const id = anchor.href.match(UUID_RE)?.[0];
      if (!id) return;
      const item = chatListItemForAnchor(anchor);
      if (!item) return;
      // 메뉴가 열려 있는 동안은 메모/스티커를 건드리지 않는다 (제자리 유지)
      if (hasOpenRoomMenu(item) || isActiveRoomMenuOpen(id)) return;
      item.dataset.rhRoomDecorated = id;
      $$(".rh-room-note-card", item).forEach((node) => node.remove());
      $$(".rh-room-note-line", item).forEach((node) => node.remove());
      const room = state.rooms[id] || {};
      if (room.note) {
        const note = document.createElement("button");
        note.type = "button";
        note.className = "rh-room-note-line";
        note.dataset.rhRoomNoteOpen = id;
        note.title = "메모 수정";
        note.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16.9 4.5 1.7-1.7a1.9 1.9 0 1 1 2.7 2.7L10.6 16.1a4.5 4.5 0 0 1-1.9 1.1L6 18l.8-2.7a4.5 4.5 0 0 1 1.1-1.9l9-9Z"/></svg>
          <span>${esc(compactFirstLine(room.note, 90))}</span>
        `;
        insertRoomNoteLine(item, room, note);
      }
      const menuButton = findRoomMoreButton(item);
      if (menuButton) decorateRoomMoreButton(menuButton, id, room);
      applyChatCardFolderColor(item, room);
    });
  }

  // 폴더 색상을 대화 카드에 적용 (설정: 배경/테두리, 중복 가능)
  function applyChatCardFolderColor(item, room) {
    const box = $("a[href*='/chat/']", item)?.firstElementChild || item;
    const fc = state.settings.chatCardFolderColor || {};
    const color = room.folderColor || state.rooms[room.id]?.folderColor || "";
    box.classList.remove("rh-folder-card-bg", "rh-folder-card-border");
    box.style.removeProperty("--rh-folder-card-color");
    if (!color || (!fc.background && !fc.border)) return;
    box.style.setProperty("--rh-folder-card-color", color);
    if (fc.background) box.classList.add("rh-folder-card-bg");
    if (fc.border) box.classList.add("rh-folder-card-border");
  }

  function compactFirstLine(value, max = 90) {
    return compact(String(value || "").split(/\n+/)[0] || "", max);
  }

  function insertRoomNoteLine(item, room, note) {
    const pair = roomPairLabel(room);
    const pairNode = findRoomPairLine(item, room) || (pair ? findTextElement(item, pair) : null);
    if (pairNode?.parentElement) {
      const target = roomPairLineContainer(pairNode, item);
      target.insertAdjacentElement("afterend", note);
      if (!verifyNotePlacement(note, item)) return;
      fixNoteParentShrink(note, item);
      return;
    }
    const titleTarget = room.title ? findTextElement(item, room.title) : null;
    const container = titleTarget?.parentElement || $("a[href*='/chat/']", item)?.parentElement || item;
    const reference = findRoomPreviewText(item, room);
    container.insertBefore(note, reference && reference.parentElement === container ? reference : null);
    if (!verifyNotePlacement(note, item)) return;
    fixNoteParentShrink(note, item);
  }

  function roomPairLineContainer(pairNode, item) {
    let target = pairNode;
    for (let depth = 0; depth < 5 && target.parentElement && target.parentElement !== item; depth += 1) {
      const parent = target.parentElement;
      const text = compact(parent.innerText || parent.textContent || "", 180);
      const rect = parent.getBoundingClientRect();
      if (text.includes("\n") || rect.height > 48) break;
      target = parent;
    }
    return target;
  }

  // 안전망: 메모가 카드 박스(링크의 첫 자식) 밖(카드 아래 등)에 꽂혔으면 표시하지 않는다
  function verifyNotePlacement(note, item) {
    const anchorEl = $("a[href*='/chat/']", item);
    const cardBox = anchorEl?.firstElementChild;
    if (!cardBox) return true;
    if (cardBox.contains(note)) return true;
    note.remove();
    return false;
  }

  // 부모 flex 아이템의 min-width:auto가 긴 nowrap 메모 때문에 컬럼을 밀어 넓히면
  // CSS 말줄임(…)이 발동하지 않는다 — 메모가 있는 동안만 min-width:0으로 고정.
  function fixNoteParentShrink(note, item) {
    let node = note.parentElement;
    for (let depth = 0; depth < 4 && node && node !== item; depth += 1) {
      node.style.minWidth = "0";
      node = node.parentElement;
    }
  }

  function findTextElement(root, text) {
    const needle = compact(text, 80);
    if (!needle) return null;
    const matches = $$("span, p, div, strong, h1, h2, h3", root)
      .filter((node) => !isHelperElement(node))
      .filter((node) => compact(node.innerText || node.textContent || "", 160).includes(needle));
    // 가장 깊은(다른 매치를 포함하지 않는) 노드를 반환한다 — 컨테이너가 아닌 실제 텍스트 요소
    return matches.find((node) => !matches.some((other) => other !== node && node.contains(other))) || null;
  }

  function findRoomPairLine(item, room) {
    const pair = roomPairLabel(room);
    const expected = pair ? normalizeRoomPairText(pair) : "";
    const nodes = $$("span, p, div, strong", item).filter((node) => !isHelperElement(node));
    return nodes
      .map((node) => ({
        node,
        text: compact(node.innerText || node.textContent || "", 120),
        rect: node.getBoundingClientRect()
      }))
      .filter((entry) => {
        const text = normalizeRoomPairText(entry.text);
        if (!text || entry.text.includes("\n")) return false;
        if (expected && text.includes(expected)) return true;
        return /.+\s*[x×]\s*.+/.test(entry.text) && entry.rect.height < 40;
      })
      .sort((a, b) => a.rect.width - b.rect.width)[0]?.node || null;
  }

  function normalizeRoomPairText(text) {
    return compact(text, 120).replace(/\s*[x×]\s*/gi, "x").replace(/\s+/g, "");
  }

  function findRoomPreviewText(item, room) {
    const title = room.title || "";
    const pair = roomPairLabel(room);
    return $$("span, p, div", item)
      .filter((node) => !isHelperElement(node))
      .find((node) => {
        const text = compact(node.innerText || node.textContent || "", 160);
        if (!text || text.includes("\n")) return false;
        if (title && text.includes(title)) return false;
        if (pair && normalizeRoomPairText(text).includes(normalizeRoomPairText(pair))) return false;
        return text.length > 20;
      }) || null;
  }

  function findRoomMoreButton(item) {
    const buttons = $$("button", item).filter((button) => isVisible(button) && !isHelperElement(button));
    return buttons
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const label = `${button.innerText || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
        const svgCount = $$("svg", button).length;
        let score = 0;
        if (/더보기|메뉴|옵션|more|menu/i.test(label)) score += 80;
        if (!button.innerText.trim() && svgCount) score += 45;
        if (rect.right > item.getBoundingClientRect().right - 80) score += 20;
        if (rect.top < item.getBoundingClientRect().top + 90) score += 10;
        return { button, score };
      })
      .filter((entry) => entry.score > 40)
      .sort((a, b) => b.score - a.score)[0]?.button || null;
  }

  function decorateRoomMoreButton(button, id, room) {
    button.dataset.rhRoomMenuId = id;
    button.classList.add("rh-room-more-button");
    // 라이브 편집 중인 카드는 편집 세션이 오버레이를 관리한다
    if (stickerEdit?.id === id) return;
    const item = chatListItemForAnchor(button) || button.closest("li, article, [role='listitem']") || button.parentElement;
    if (room.sticker) {
      button.classList.add("rh-room-sticker-button");
      syncRoomStickerOverlay(item, button, room.sticker);
    } else {
      button.classList.remove("rh-room-sticker-button");
      $(".rh-room-sticker-overlay", item || document)?.remove();
    }
  }

  const STICKER_BASE_SIZE = 56;

  function syncRoomStickerOverlay(item, button, sticker, options = {}) {
    if (!item || !button) return;
    const itemStyle = getComputedStyle(item);
    if (itemStyle.position === "static") item.classList.add("rh-room-sticker-host");
    let overlay = $(".rh-room-sticker-overlay", item);
    if (!overlay) {
      overlay = document.createElement("span");
      overlay.className = "rh-room-sticker-overlay";
      item.append(overlay);
    }
    const itemRect = item.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const size = Math.round(STICKER_BASE_SIZE * Math.min(4, Math.max(0.4, Number(sticker.scale || 1))));
    let left = buttonRect.left - itemRect.left + buttonRect.width / 2 + Number(sticker.x || 0);
    let top = buttonRect.top - itemRect.top + buttonRect.height / 2 + Number(sticker.y || 0);
    // 스티커 중심이 카드 영역 밖으로 나가지 않게 고정 (최대 절반만 밖으로 걸침)
    left = Math.max(6, Math.min(itemRect.width - 6, left));
    top = Math.max(6, Math.min(itemRect.height - 6, top));
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.style.width = `${size}px`;
    overlay.style.height = `${size}px`;
    overlay.classList.toggle("rh-editing", Boolean(options.editing));
    // 편집 중이 아닐 때 스티커는 그 자체가 ... 메뉴 버튼
    overlay.classList.toggle("rh-sticker-menu-proxy", !options.editing);
    overlay.title = options.editing ? "" : "메뉴 열기";
    const rotation = Number(sticker.rotation || 0);
    const editUi = options.editing ? `
      <span class="rh-sticker-frame"></span>
      <button type="button" class="rh-sticker-handle-rotate" title="회전">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>
      </button>
      <button type="button" class="rh-sticker-handle-scale" title="크기"></button>
    ` : "";
    const stickerHtml = renderRoomSticker(sticker);
    const menuHit = options.editing
      ? stickerHtml
      : `<button type="button" class="rh-sticker-menu-hit" title="메뉴 열기">${stickerHtml}</button>`;
    const html = `
      <span class="rh-sticker-rotor" style="transform: rotate(${rotation}deg)">
        ${menuHit}
        ${editUi}
      </span>
    `;
    if (overlay.dataset.rhStickerHtml !== html) {
      overlay.innerHTML = html;
      overlay.dataset.rhStickerHtml = html;
    } else {
      const rotor = $(".rh-sticker-rotor", overlay);
      if (rotor) rotor.style.transform = `rotate(${rotation}deg)`;
    }
  }

  function enhanceChatListMenus() {
    if (!activeRoomMenuId) return;
    $$(".rh-room-menu-items").forEach((node) => node.remove());
    const rename = findRoomRenameMenuItem();
    if (!rename?.parentElement) return;
    const wrap = document.createElement("div");
    wrap.className = "rh-room-menu-items";
    wrap.innerHTML = `
      <button type="button" data-rh-room-menu-action="memo" data-id="${esc(activeRoomMenuId)}">${MENU_ICONS.memo}<span>대화방 메모</span></button>
      <button type="button" data-rh-room-menu-action="sticker" data-id="${esc(activeRoomMenuId)}">${MENU_ICONS.sticker}<span>스티커 설정</span></button>
    `;
    rename.insertAdjacentElement("afterend", wrap);
  }

  function isActiveRoomMenuOpen(id) {
    if (!id || activeRoomMenuId !== id) return false;
    return Boolean(findRoomRenameMenuItem());
  }

  function findRoomRenameMenuItem() {
    return $$("button, [role='menuitem'], li")
      .filter((node) => isVisible(node) && !isHelperElement(node))
      .map((node) => ({
        node,
        text: compact(node.innerText || node.textContent || "", 80),
        rect: node.getBoundingClientRect()
      }))
      .filter((entry) => /대화방\s*이름\s*변경/.test(entry.text))
      .sort((a, b) => (a.text.length - b.text.length) || (a.rect.width * a.rect.height - b.rect.width * b.rect.height))[0]?.node || null;
  }

  function renderRoomSticker(sticker = {}) {
    if (sticker.image) {
      return `<span class="rh-room-sticker"><img src="${esc(sticker.image)}" alt=""></span>`;
    }
    const kind = sticker.kind || "flower";
    return `<span class="rh-room-sticker">${ROOM_STICKERS[kind] || ROOM_STICKERS.flower}</span>`;
  }

  /* 스티커 프리셋 — 흰 테두리로 실제 스티커처럼 오려낸 느낌 */
  const ROOM_STICKERS = {
    flower: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC200" stroke="#fff" stroke-width="2.4" stroke-linejoin="round" d="M24 6c2.8 0 5 2 5.6 4.6 2.2-1.6 5.2-1.5 7.2.5s2.1 5 .5 7.2C39.9 18.9 42 21.2 42 24s-2.1 5.1-4.7 5.7c1.6 2.2 1.5 5.2-.5 7.2s-5 2.1-7.2.5C29 40 26.8 42 24 42s-5-2-5.6-4.6c-2.2 1.6-5.2 1.5-7.2-.5s-2.1-5-.5-7.2C8.1 29.1 6 26.8 6 24s2.1-5.1 4.7-5.7c-1.6-2.2-1.5-5.2.5-7.2s5-2.1 7.2-.5C19 8 21.2 6 24 6Z"/><circle cx="24" cy="24" r="6" fill="#E8A000"/></svg>`,
    heart: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FF7A9E" stroke="#fff" stroke-width="2.4" stroke-linejoin="round" d="M24 41s-14-8.8-18.5-17.4C1.4 15.6 6.4 8.5 13.9 8.5c4 0 7.2 2 10.1 5.6 2.9-3.6 6.1-5.6 10.1-5.6 7.5 0 12.5 7.1 8.4 15.1C38 32.2 24 41 24 41Z"/></svg>`,
    star: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC94A" stroke="#fff" stroke-width="2.4" stroke-linejoin="round" d="m24 4 5.9 12 13.1 1.9-9.5 9.3 2.2 13.1L24 34.1l-11.7 6.2 2.2-13.1L5 17.9 18.1 16 24 4Z"/></svg>`,
    sparkle: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFE066" stroke="#fff" stroke-width="2.4" stroke-linejoin="round" d="M24 4c1.4 8.9 4.5 15.6 9.4 18.6 3-.5 6.6-1.7 10.6-3.6-6.9 5-10.6 9.9-11.4 15-.5 3 .1 6.7 1.4 11-4-6.3-8-9.9-12-11-3.7 1.1-7.7 4.7-11.7 11 1.3-4.3 1.9-8 1.4-11-.8-5.1-4.5-10-11.4-15 4 1.9 7.6 3.1 10.6 3.6 4.9-3 8-9.7 9.4-18.6Z" transform="scale(.86) translate(4 4)"/></svg>`,
    ribbon: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#8AB4FF" stroke="#fff" stroke-width="2.4" stroke-linejoin="round" d="M24 27.5 10 40l3-13.4C9.4 24.5 7 20.6 7 16.5 7 9.6 14.6 5 24 5s17 4.6 17 11.5c0 4.1-2.4 8-6 10.1L38 40 24 27.5Z"/><circle cx="24" cy="16.5" r="4.4" fill="#fff"/></svg>`
  };

  function collectCurrentChatRoomPatch() {
    const roomId = currentRoomId();
    const prev = state.rooms[roomId] || {};
    const title = compact($("h1")?.innerText || document.title.replace(/\s*\|\s*로판 AI.*$/i, ""), 80);
    const characterLink = $("a[href*='/character/']");
    const characterId = characterLink?.href?.match(UUID_RE)?.[0] || currentCharacterId() || prev.characterId || "";
    const char = characterId ? state.characters[characterId] || {} : {};
    return {
      id: roomId,
      url: `/chat/${roomId}`,
      title: title || prev.title || char.name || "대화방",
      characterId,
      characterName: char.name || prev.characterName || "",
      characterImage: char.image || prev.characterImage || ""
    };
  }

  function showRoomEditor(id, anchor) {
    if (!id) return;
    const room = ensureRoom(id, { url: `/chat/${id}` });
    if (!roomEditor) {
      roomEditor = document.createElement("section");
      roomEditor.id = "rofan-helper-room-editor";
      document.documentElement.append(roomEditor);
    }
    roomEditor.dataset.roomId = id;
    roomEditor.innerHTML = renderRoomEditor(room);
    roomEditor.hidden = false;
    positionRoomEditor(anchor);
    $("textarea", roomEditor)?.focus();
  }

  function renderRoomEditor(room) {
    return `
      <header>
        <div>
          <strong>${esc(room.title || "대화방")}</strong>
          <small>${esc(roomPairLabel(room) || room.folderName || room.url || "")}</small>
        </div>
        <button type="button" data-rh-room-editor-close title="닫기">×</button>
      </header>
      <label>대화방 메모
        <textarea data-rh-room-note-input="${esc(room.id)}" placeholder="이 대화방에 대한 메모를 적어두세요.">${esc(room.note || "")}</textarea>
      </label>
      <div class="rh-room-avatar-edit">
        ${renderRoomImageEditor(room, "characterAvatar", "캐릭터")}
        ${renderRoomImageEditor(room, "personaAvatar", "페르소나")}
      </div>
      <div class="rh-actions">
        <button type="button" data-rh-room-open="${esc(room.id)}">대화방 열기</button>
      </div>
    `;
  }

  function renderRoomImageEditor(room, field, label) {
    const name = field === "characterAvatar" ? room.characterName : room.personaName;
    return `
      <div class="rh-room-image-field">
        ${renderRoomAvatar(room, field, name, "rh-room-image-preview")}
        <label>${esc(label)} 이미지
          <input type="file" accept="image/*" data-rh-room-image="${esc(field)}" data-id="${esc(room.id)}">
        </label>
        ${room[field] ? `<button type="button" data-rh-room-image-clear="${esc(field)}" data-id="${esc(room.id)}">삭제</button>` : ""}
      </div>
    `;
  }

  function positionRoomEditor(anchor) {
    if (!roomEditor) return;
    if (!anchor?.getBoundingClientRect) {
      roomEditor.style.left = "50%";
      roomEditor.style.top = "50%";
      roomEditor.style.transform = "translate(-50%, -50%)";
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const editorRect = roomEditor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - editorRect.width - 12, Math.max(12, rect.left));
    const top = Math.min(window.innerHeight - editorRect.height - 12, Math.max(12, rect.bottom + 8));
    roomEditor.style.left = `${left}px`;
    roomEditor.style.top = `${top}px`;
    roomEditor.style.transform = "none";
  }

  function closeRoomEditor() {
    if (roomEditor) roomEditor.hidden = true;
  }

  function showRoomMemoDialog(id) {
    if (!id) return;
    const room = ensureRoom(id, { url: `/chat/${id}` });
    if (!roomDialog) {
      roomDialog = document.createElement("section");
      roomDialog.id = "rofan-helper-room-dialog";
      document.documentElement.append(roomDialog);
    }
    roomDialog.dataset.roomId = room.id;
    roomDialog.dataset.type = "memo";
    roomDialog.innerHTML = renderRoomMemoDialog(room);
    roomDialog.hidden = false;
    $("[data-rh-room-memo-value]", roomDialog)?.focus();
  }

  // 사이트의 "대화방 이름 설정" 모달과 동일한 디자인 문법
  function renderRoomMemoDialog(room) {
    const pair = roomPairLabel(room);
    return `
      <div class="rh-room-dialog-backdrop" data-rh-room-dialog-cancel></div>
      <div class="rh-room-dialog-card" role="dialog" aria-modal="true">
        <button type="button" class="rh-room-dialog-x" data-rh-room-dialog-cancel title="닫기">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6l12 12"/></svg>
        </button>
        <div class="rh-room-dialog-head">
          <h3>대화방 메모</h3>
          <p>메모는 내 브라우저에만 저장됩니다</p>
        </div>
        <div class="rh-room-dialog-room">
          <div>
            <p class="rh-room-dialog-room-label">대화방</p>
            <p class="rh-room-dialog-room-name">${esc(room.title || "대화방")}${pair ? ` <span>· ${esc(pair)}</span>` : ""}</p>
          </div>
        </div>
        <textarea data-rh-room-memo-value placeholder="이 대화방에 대한 메모를 남겨두세요." maxlength="500">${esc(room.note || "")}</textarea>
        <div class="rh-room-dialog-actions">
          <button type="button" data-rh-room-dialog-cancel>취소</button>
          <button type="button" data-rh-room-dialog-save>완료</button>
        </div>
      </div>
    `;
  }

  async function saveRoomDialog() {
    if (!roomDialog) return;
    const id = roomDialog.dataset.roomId;
    if (!id) return;
    ensureRoom(id, { note: $("[data-rh-room-memo-value]", roomDialog)?.value || "" });
    await saveState();
    closeRoomDialog();
    applyEnhancements({ preserveEditors: true });
    showToast("대화방 메모를 저장했어요.");
  }

  function closeRoomDialog() {
    if (roomDialog) roomDialog.hidden = true;
  }

  /* ------------------------------------------------------------------
     스티커 라이브 편집 — 미리보기가 아니라 실제 카드 위에서
     드래그(이동) / 손잡이(크기·회전) 조작으로 편집한다.
     ------------------------------------------------------------------ */

  function closeSiteRoomMenu() {
    const backdrop = $$("div[class*='fixed'][class*='inset-0'][class*='z-20']")
      .find((node) => !isHelperElement(node));
    backdrop?.click();
  }

  function enterStickerEdit(id) {
    if (!id) return;
    exitStickerEdit(false);
    const button = $(`.rh-room-more-button[data-rh-room-menu-id='${cssEscape(id)}']`);
    const item = button ? chatListItemForAnchor(button) || button.closest("[data-rh-room-decorated]") : $(`[data-rh-room-decorated='${cssEscape(id)}']`);
    if (!item || !button) {
      showToast("카드를 찾지 못했어요. 대화목록 화면에서 다시 시도해주세요.");
      return;
    }
    const room = ensureRoom(id, { url: `/chat/${id}` });
    const prev = room.sticker ? { ...room.sticker } : null;
    const draft = {
      kind: room.sticker?.kind || "flower",
      image: room.sticker?.image || "",
      scale: Number(room.sticker?.scale || 1.6),
      rotation: Number(room.sticker?.rotation ?? -8),
      x: Number(room.sticker?.x || 0),
      y: Number(room.sticker?.y || 0)
    };
    stickerEdit = { id, item, button, prev, draft, toolbar: null };
    item.classList.add("rh-sticker-editing-host");
    syncRoomStickerOverlay(item, button, draft, { editing: true });
    showStickerToolbar();
    applyStickerDraft();
    window.addEventListener("keydown", stickerEditKeydown, true);
    window.addEventListener("scroll", positionStickerToolbar, { passive: true });
    window.addEventListener("resize", positionStickerToolbar, { passive: true });
  }

  async function exitStickerEdit(save) {
    if (!stickerEdit) return;
    const { id, item, button, prev, draft } = stickerEdit;
    $("#rofan-helper-sticker-toolbar")?.remove();
    window.removeEventListener("keydown", stickerEditKeydown, true);
    window.removeEventListener("scroll", positionStickerToolbar);
    window.removeEventListener("resize", positionStickerToolbar);
    item.classList.remove("rh-sticker-editing-host");
    stickerEdit = null;
    if (save) {
      ensureRoom(id, { sticker: { ...draft } });
      await saveState();
      showToast("스티커를 붙였어요.");
    } else {
      ensureRoom(id, { sticker: prev });
    }
    decorateRoomMoreButton(button, id, state.rooms[id] || {});
    if (!state.rooms[id]?.sticker) $(".rh-room-sticker-overlay", item)?.remove();
  }

  async function removeStickerFromEdit() {
    if (!stickerEdit) return;
    const { id, item, button } = stickerEdit;
    $("#rofan-helper-sticker-toolbar")?.remove();
    window.removeEventListener("keydown", stickerEditKeydown, true);
    window.removeEventListener("scroll", positionStickerToolbar);
    window.removeEventListener("resize", positionStickerToolbar);
    item.classList.remove("rh-sticker-editing-host");
    stickerEdit = null;
    ensureRoom(id, { sticker: null });
    await saveState();
    $(".rh-room-sticker-overlay", item)?.remove();
    decorateRoomMoreButton(button, id, state.rooms[id] || {});
    showToast("스티커를 제거했어요.");
  }

  function stickerEditKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitStickerEdit(false);
    }
  }

  function showStickerToolbar() {
    if (!stickerEdit) return;
    $("#rofan-helper-sticker-toolbar")?.remove();
    const toolbar = document.createElement("div");
    toolbar.id = "rofan-helper-sticker-toolbar";
    toolbar.innerHTML = `
      <p class="rh-sticker-toolbar-hint">스티커를 드래그해 옮기고, 손잡이로 크기·회전을 조절하세요.<br>완료하면 이 스티커가 <strong>⋮ 메뉴 버튼</strong>이 됩니다.</p>
      <div class="rh-sticker-toolbar-presets">
        ${Object.keys(ROOM_STICKERS).map((key) => `
          <button type="button" data-rh-sticker-preset="${esc(key)}" title="${esc(key)}">${ROOM_STICKERS[key]}</button>
        `).join("")}
        <label class="rh-sticker-photo" title="내 사진 붙이기">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5.2-5.2a1.5 1.5 0 0 1 2.1 0L21 19"/></svg>
          <input type="file" accept="image/*" data-rh-sticker-image>
        </label>
      </div>
      <div class="rh-sticker-toolbar-actions">
        <button type="button" class="rh-sticker-remove" data-rh-sticker-action="remove">제거</button>
        <button type="button" data-rh-sticker-action="cancel">취소</button>
        <button type="button" class="rh-sticker-done" data-rh-sticker-action="done">완료</button>
      </div>
    `;
    document.documentElement.append(toolbar);
    stickerEdit.toolbar = toolbar;
    positionStickerToolbar();
  }

  function positionStickerToolbar() {
    if (!stickerEdit?.toolbar) return;
    const overlay = $(".rh-room-sticker-overlay", stickerEdit.item);
    const anchorRect = (overlay || stickerEdit.button).getBoundingClientRect();
    const toolbar = stickerEdit.toolbar;
    const width = toolbar.offsetWidth || 264;
    const height = toolbar.offsetHeight || 130;
    let left = anchorRect.left + anchorRect.width / 2 - width / 2;
    left = Math.max(10, Math.min(window.innerWidth - width - 10, left));
    let top = anchorRect.bottom + 14;
    if (top + height > window.innerHeight - 10) top = anchorRect.top - height - 14;
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${Math.max(10, top)}px`;
  }

  function applyStickerDraft() {
    if (!stickerEdit) return;
    syncRoomStickerOverlay(stickerEdit.item, stickerEdit.button, stickerEdit.draft, { editing: true });
    positionStickerToolbar();
  }

  // 드래그 중에도 저장값(x/y) 자체를 카드 안으로 고정한다
  function clampStickerDraftToItem() {
    if (!stickerEdit) return;
    const itemRect = stickerEdit.item.getBoundingClientRect();
    const buttonRect = stickerEdit.button.getBoundingClientRect();
    const baseX = buttonRect.left - itemRect.left + buttonRect.width / 2;
    const baseY = buttonRect.top - itemRect.top + buttonRect.height / 2;
    stickerEdit.draft.x = Math.round(Math.max(6 - baseX, Math.min(itemRect.width - 6 - baseX, stickerEdit.draft.x)));
    stickerEdit.draft.y = Math.round(Math.max(6 - baseY, Math.min(itemRect.height - 6 - baseY, stickerEdit.draft.y)));
  }

  // 스티커 포인터 조작: 본체 드래그 = 이동, ↻ = 회전, ⤡ = 크기
  document.addEventListener("pointerdown", (event) => {
    if (!stickerEdit) return;
    const overlay = event.target.closest(".rh-room-sticker-overlay.rh-editing");
    if (!overlay) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = overlay.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const mode = event.target.closest(".rh-sticker-handle-rotate")
      ? "rotate"
      : event.target.closest(".rh-sticker-handle-scale") ? "scale" : "move";
    const start = {
      mode,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: stickerEdit.draft.x,
      y: stickerEdit.draft.y,
      scale: stickerEdit.draft.scale,
      rotation: stickerEdit.draft.rotation,
      center,
      distance: Math.max(12, Math.hypot(event.clientX - center.x, event.clientY - center.y)),
      angle: Math.atan2(event.clientY - center.y, event.clientX - center.x)
    };
    const onMove = (moveEvent) => {
      if (!stickerEdit) return;
      if (start.mode === "move") {
        stickerEdit.draft.x = Math.round(start.x + moveEvent.clientX - start.pointerX);
        stickerEdit.draft.y = Math.round(start.y + moveEvent.clientY - start.pointerY);
        clampStickerDraftToItem();
      } else if (start.mode === "scale") {
        const distance = Math.max(12, Math.hypot(moveEvent.clientX - start.center.x, moveEvent.clientY - start.center.y));
        stickerEdit.draft.scale = Math.min(4, Math.max(0.4, start.scale * (distance / start.distance)));
      } else {
        const angle = Math.atan2(moveEvent.clientY - start.center.y, moveEvent.clientX - start.center.x);
        stickerEdit.draft.rotation = Math.round(start.rotation + (angle - start.angle) * 180 / Math.PI);
      }
      applyStickerDraft();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, true);

  function cssEscape(value) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function renderRoomAvatar(room, field, fallbackName, className = "") {
    const src = room[field];
    const label = firstAvatarLetter(fallbackName || room.title || "R");
    const color = roomAvatarColor(fallbackName || room.title || room.id);
    if (src) {
      return `<span class="rh-room-avatar ${esc(className)}"><img src="${esc(src)}" alt=""></span>`;
    }
    return `<span class="rh-room-avatar ${esc(className)}" style="--rh-room-avatar-bg:${esc(color)}">${esc(label)}</span>`;
  }

  function firstAvatarLetter(value) {
    return Array.from(String(value || "R").trim())[0] || "R";
  }

  function roomAvatarColor(value) {
    let hash = 0;
    String(value || "room").split("").forEach((ch) => {
      hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    });
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 32% 34%)`;
  }

  async function storeRoomImageFromFile(roomId, field, file) {
    if (!roomId || !field || !file) return;
    const dataUrl = await fileToSquareJpeg(file, 200, 0.95);
    ensureRoom(roomId, { [field]: dataUrl });
    await saveState();
    showRoomEditor(roomId, roomEditor);
    applyEnhancements({ preserveEditors: true });
  }

  // 스티커용: 정사각 크롭 없이 비율 유지 + 투명 배경 보존(PNG)
  function fileToStickerImage(file, maxSize = 280) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        image.onload = () => {
          const width = image.naturalWidth || image.width;
          const height = image.naturalHeight || image.height;
          const ratio = Math.min(1, maxSize / Math.max(width, height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * ratio));
          canvas.height = Math.max(1, Math.round(height * ratio));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = reject;
        image.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function fileToSquareJpeg(file, size = 200, quality = 0.95) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const reader = new FileReader();
      reader.onload = () => {
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          const side = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
          const sx = Math.max(0, ((image.naturalWidth || image.width) - side) / 2);
          const sy = Math.max(0, ((image.naturalHeight || image.height) - side) / 2);
          ctx.drawImage(image, sx, sy, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        image.onerror = reject;
        image.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function enhanceChatRoomHeader() {
    const roomId = currentRoomId();
    const room = ensureRoom(roomId, collectCurrentChatRoomPatch());
    const button = findChatMenuButton();
    if (!button || button.classList.contains("rh-chat-avatar-button")) {
      if (button) button.innerHTML = renderChatAvatarButton(room);
      return;
    }
    button.classList.add("rh-chat-avatar-button");
    button.dataset.rhOriginalTitle = button.title || button.getAttribute("aria-label") || "";
    button.title = "대화방 메모/이미지";
    button.setAttribute("aria-label", "대화방 메모/이미지");
    button.innerHTML = renderChatAvatarButton(room);
  }

  function findChatMenuButton() {
    const existing = $(".rh-chat-avatar-button");
    if (existing) return existing;
    const buttons = $$("button").filter((button) => {
      if (!isVisible(button) || isHelperElement(button)) return false;
      const rect = button.getBoundingClientRect();
      if (rect.top > 180 || rect.right < window.innerWidth - 260) return false;
      const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""} ${button.innerText || ""}`;
      const svgCount = $$("svg", button).length;
      return /더보기|메뉴|옵션|more|menu|setting|설정/i.test(label) || (!button.innerText.trim() && svgCount > 0);
    });
    return buttons.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || br.right - ar.right;
    })[0] || null;
  }

  function renderChatAvatarButton(room) {
    return `
      <span class="rh-chat-avatar-pair">
        ${renderRoomAvatar(room, "characterAvatar", room.characterName || room.title)}
        <span class="rh-chat-avatar-x">×</span>
        ${renderRoomAvatar(room, "personaAvatar", room.personaName || "페르소나")}
      </span>
    `;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
  }

  function applyFolderColors() {
    const entries = Object.entries(state.settings.folderColors || {});
    if (!entries.length) return;
    $$("a, button, li, [role='button']").forEach((node) => {
      const text = node.innerText?.trim();
      if (!text) return;
      const hit = entries.find(([name]) => text.includes(name));
      if (!hit) return;
      node.style.setProperty("--rh-folder-color", hit[1]);
      node.classList.add("rh-folder-color");
    });
  }

  function randomCharacter() {
    const cards = collectCards().filter(({ card }) => !card.classList.contains("rh-hidden-card"));
    if (!cards.length) return;
    const pick = cards[Math.floor(Math.random() * cards.length)];
    pick.anchor.click();
  }

  function copyCharacterLink() {
    const id = currentCharacterId();
    copyText(id ? `${location.origin}/character/${id}` : location.href);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  }

  function collectChatMessages() {
    const nodes = uniqueBy(CHAT_SCAN_SELECTORS.flatMap((selector) => $$(selector)), (node) => node);
    const messages = nodes
      .map((node) => compact(node.innerText || node.textContent || "", 5000))
      .filter((text) => text.length > 8)
      .filter((text, index, arr) => arr.findIndex((item) => item === text || item.includes(text)) === index)
      .map((text, index) => ({ index: index + 1, text }));
    if (messages.length) return messages;
    return [{ index: 1, text: compact(document.body.innerText, 20000) }];
  }

  function chatPayload() {
    const id = currentCharacterId();
    const roomId = currentRoomId();
    return {
      exportedAt: nowIso(),
      url: location.href,
      characterId: id,
      character: id ? state.characters[id] || null : null,
      roomId,
      room: state.rooms[roomId] || null,
      messages: collectChatMessages()
    };
  }

  function downloadChat(format) {
    const payload = chatPayload();
    const name = payload.character?.name || "rofan-chat";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let content;
    let ext;
    let type;
    if (format === "json") {
      content = JSON.stringify(payload, null, 2);
      ext = "json";
      type = "application/json";
    } else if (format === "md") {
      content = `# ${name}\n\n- URL: ${payload.url}\n- Exported: ${payload.exportedAt}\n\n${payload.messages.map((msg) => `## Message ${msg.index}\n\n${msg.text}`).join("\n\n")}\n`;
      ext = "md";
      type = "text/markdown";
    } else {
      content = `${name}\n${payload.url}\n${payload.exportedAt}\n\n${payload.messages.map((msg) => `[${msg.index}]\n${msg.text}`).join("\n\n")}`;
      ext = "txt";
      type = "text/plain";
    }
    downloadFile(`rofan-${safeName(name)}-${stamp}.${ext}`, content, type);
  }

  function downloadFile(filename, content, type = "application/octet-stream") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeName(name) {
    return String(name || "data").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
  }

  function searchChat(query) {
    clearSearch();
    const q = query.trim().toLowerCase();
    if (!q) return;
    collectMessageNodes().forEach((node) => {
      if ((node.innerText || "").toLowerCase().includes(q)) node.classList.add("rh-search-hit");
    });
  }

  function clearSearch() {
    $$(".rh-search-hit").forEach((node) => node.classList.remove("rh-search-hit"));
  }

  function collectMessageNodes() {
    return uniqueBy(CHAT_SCAN_SELECTORS.flatMap((selector) => $$(selector)), (node) => node)
      .filter((node) => (node.innerText || "").trim().length > 8);
  }

  function toggleStarMode() {
    starMode = !starMode;
    if (starMode) decorateMessages();
    else $$(".rh-star-button").forEach((node) => node.remove());
    renderPanel("chat");
  }

  function decorateMessages() {
    const roomId = currentRoomId();
    const important = state.importantMessages[roomId] || {};
    collectMessageNodes().forEach((node) => {
      if ($(":scope > .rh-star-button", node)) return;
      const hash = textHash(node.innerText || "");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rh-star-button";
      button.textContent = important[hash] ? "★" : "☆";
      button.title = "중요 메시지";
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.importantMessages[roomId] = state.importantMessages[roomId] || {};
        if (state.importantMessages[roomId][hash]) delete state.importantMessages[roomId][hash];
        else state.importantMessages[roomId][hash] = { at: nowIso(), text: compact(node.innerText, 500) };
        await saveState();
        button.textContent = state.importantMessages[roomId][hash] ? "★" : "☆";
      });
      node.classList.add("rh-message-markable");
      node.append(button);
    });
  }

  function textHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function setupAutosave() {
    clearInterval(autosaveTimer);
    if (!state.settings.chatAutosave) return;
    autosaveTimer = setInterval(async () => {
      if (!looksLikeChatPage()) return;
      const roomId = currentRoomId();
      const payload = chatPayload();
      state.backups[roomId] = payload;
      ensureRoom(roomId, { lastAutosavedAt: nowIso() });
      await saveState();
    }, Math.max(1, state.settings.autosaveMinutes || 3) * 60 * 1000);
  }

  function exportData() {
    downloadFile(`rofan-helper-data-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
  }

  async function importData() {
    const raw = $("[data-field='import-json']", panel)?.value.trim();
    if (!raw) return;
    try {
      state = mergeState(JSON.parse(raw));
      await saveState();
      applyEnhancements();
      renderPanel("data");
    } catch {
      alert("JSON을 읽을 수 없습니다.");
    }
  }

  function runUserScripts() {
    (state.settings.userScripts || []).forEach((source) => {
      try {
        Function("state", source)(structuredClone(state));
      } catch (error) {
        console.error("[Rofan Helper] user script failed", error);
      }
    });
  }

  function shouldDeferAutoEnhance() {
    const active = document.activeElement;
    if (active?.matches?.("input, textarea, select, [contenteditable='true']")) return true;
    return $$("[role='dialog'], [aria-modal='true'], [data-radix-dialog-content], [class*='modal' i]")
      .some((node) => !isHelperElement(node) && isVisible(node));
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function renderCalendar() {
    const counts = state.playLog.reduce((acc, item) => {
      acc[item.date] = (acc[item.date] || 0) + 1;
      return acc;
    }, {});
    const days = [];
    const end = new Date();
    for (let i = 83; i >= 0; i -= 1) {
      const d = new Date(end);
      d.setDate(end.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push(`<span title="${key}: ${counts[key] || 0}" data-count="${Math.min(4, counts[key] || 0)}"></span>`);
    }
    return `<div class="rh-calendar">${days.join("")}</div>`;
  }

  function renderStats() {
    const topCharacters = topBy(state.playLog, "characterId").slice(0, 5)
      .map(([id, count]) => `${state.characters[id]?.name || shortId(id)} ${count}`).join("<br>");
    const topCreators = topBy(state.playLog, "creatorId").slice(0, 5)
      .map(([id, count]) => `${creatorDisplayName(state.creators[id]) || "닉네임 미지정"} ${count}`).join("<br>");
    return `<div class="rh-stats"><p><strong>캐릭터</strong><br>${topCharacters || "기록 없음"}</p><p><strong>제작자</strong><br>${topCreators || "기록 없음"}</p></div>`;
  }

  function topBy(items, key) {
    const map = new Map();
    items.forEach((item) => {
      if (!item[key]) return;
      map.set(item[key], (map.get(item[key]) || 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }

  const queueApply = debounce(async () => {
    if (renderQueued) return;
    renderQueued = true;
    // 캐릭터 모달이 열려 있는 동안은 카드 재장식을 멈추고(React와 충돌 방지)
    // 모달 관련 처리만 수행한다.
    if (hasOpenCharacterModal()) {
      fixCharacterModalPositioning();
      enhanceCharacterModals();
      renderQueued = false;
      return;
    }
    fixCharacterModalPositioning();
    if (shouldDeferAutoEnhance()) {
      renderQueued = false;
      return;
    }
    await ingestPageData();
    applyEnhancements({ preserveEditors: true });
    renderQueued = false;
  }, 500);

  function hasOpenCharacterModal() {
    return characterModalCandidateNodes().length > 0;
  }

  // 정렬 select(대화량순/인기순/최신순/오래된순/업데이트순)를 바꾸면 목록이 재정렬된다.
  // change 이벤트를 직접 듣고, 재정렬이 반영될 시간을 두고 여러 번 카드를 재장식한다.
  function handleSortChange(event) {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    // 정렬 select인지 확인 (옵션 값이 정렬 키 형태)
    const values = Array.from(select.options).map((o) => o.value).join(" ");
    if (!/chat_count|user_count|created_|updated_|_desc|_asc/i.test(values)) return;
    // 사이트가 새 목록을 그릴 시간을 두고 몇 차례 재장식
    [150, 500, 1000].forEach((delay) => setTimeout(() => {
      if (!hasOpenCharacterModal()) applyEnhancements({ preserveEditors: true });
    }, delay));
  }

  function watchRoute() {
    document.addEventListener("change", handleSortChange, true);
    setInterval(() => {
      if (route === location.href) return;
      route = location.href;
      queueApply();
    }, 600);
    observer = new MutationObserver((mutations) => {
      let modalMounted = false;
      let modalRemoved = false;
      mutations.forEach((mutation) => {
        [...mutation.addedNodes]
          .filter((node) => node.nodeType === Node.ELEMENT_NODE)
          .forEach((node) => {
            markCharacterModalHosts(node);
            if (isRofanCharacterModalCandidate(node) || characterModalCandidateNodes(node).length) {
              modalMounted = true;
            }
          });
        [...mutation.removedNodes]
          .filter((node) => node.nodeType === Node.ELEMENT_NODE)
          .forEach((node) => {
            if (isRofanCharacterModalCandidate(node) || characterModalCandidateNodes(node).length) {
              modalRemoved = true;
            }
          });
      });
      // 모달이 뜨는 즉시(디바운스 없이) 위치 보정 — 조상의 transform/filter가
      // position:fixed의 기준을 카드/섹션으로 바꿔 모달이 페이지 아래로 떨어지는 것 방지
      if (modalMounted) fixCharacterModalPositioning();
      // 모달이 닫히면 디바운스를 기다리지 않고 바로 카드 재장식 —
      // React가 카드를 새로 그린 직후 통계/제작자 표시가 비어 보이는 공백을 최소화
      if (modalRemoved && !hasOpenCharacterModal()) {
        fixCharacterModalPositioning();
        setTimeout(() => {
          if (!hasOpenCharacterModal()) applyEnhancements({ preserveEditors: true });
        }, 80);
      }
      if (mutations.every(isHelperMutation)) return;
      // 대화목록이면 스티커/메모를 빠르게(90ms) 재장식해 페이지 넘김 지연을 줄인다
      if (isChatListPage()) scheduleChatListDecorate();
      queueApply();
    });
    // childList 외에 href 속성 변경도 감시한다 — 정렬 변경 시 React가 카드 요소를
    // 재사용하며 href(및 이미지)만 바꾸는 경우, childList만 보면 재장식 신호를 놓친다.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"]
    });
  }

  function isHelperMutation(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE);
    if (nodes.length) {
      if (nodes.some((node) => isRofanCharacterModalCandidate(node) || characterModalCandidateNodes(node).length)) return false;
      return nodes.every((node) => isHelperElement(node));
    }
    return isHelperElement(mutation.target);
  }

  function isHelperElementStrict(node) {
    return Boolean(node.closest?.(
      "#rofan-helper-launcher, #rofan-helper-nav-button, #rofan-helper-list-toolbar, #rofan-helper-panel, #rofan-helper-toast, #rofan-helper-creator-menu, #rofan-helper-chat-counter, #rofan-helper-import-overlay, #rofan-helper-sc-dropdown, #rofan-helper-sc-chips, #rofan-helper-img-tools, #rofan-helper-nai-modal, .rh-nai-msg-btn, .rh-card-info, .rh-card-image-stats, .rh-card-image-host, .rh-inline-new-badge, .rh-modal-average-stat, .rh-modal-refresh-button"
        + ", #rofan-helper-room-editor, #rofan-helper-room-dialog, #rofan-helper-sticker-toolbar, .rh-room-note-card, .rh-room-note-line, .rh-room-menu-items, .rh-room-avatar, .rh-room-sticker, .rh-room-sticker-overlay, .rh-chat-avatar-button"
    ));
  }

  function isHelperElement(node) {
    return isHelperElementStrict(node) || Boolean(node.closest?.(
      "#rofan-helper-launcher, #rofan-helper-nav-button, #rofan-helper-list-toolbar, #rofan-helper-panel, #rofan-helper-toast, #rofan-helper-creator-menu, #rofan-helper-chat-counter, #rofan-helper-import-overlay, #rofan-helper-sc-dropdown, #rofan-helper-sc-chips, #rofan-helper-img-tools, #rofan-helper-nai-modal, .rh-nai-msg-btn, .rh-card-info, .rh-card-image-stats, .rh-card-image-host, .rh-inline-new-badge, .rh-modal-average-stat, .rh-modal-refresh-button, .rh-card-shell"
        + ", #rofan-helper-room-editor, #rofan-helper-room-dialog, #rofan-helper-sticker-toolbar, .rh-room-note-card, .rh-room-note-line, .rh-room-menu-items, .rh-room-avatar, .rh-room-sticker, .rh-room-sticker-overlay, .rh-chat-avatar-button"
    ));
  }

  // 과거 버그로 캐릭터 제작자가 "나(대화 소유자)"로 잘못 저장된 것을 정리한다.
  async function cleanupSelfCreator() {
    const myId = currentUserId();
    if (!myId) return;
    let changed = false;
    Object.values(state.characters).forEach((ch) => {
      if (ch && ch.creatorId === myId) { delete ch.creatorId; changed = true; }
    });
    if (state.creators[myId] && !state.creators[myId].following) {
      delete state.creators[myId];
      changed = true;
    }
    if (changed) await saveState();
  }

  async function init() {
    state = mergeState(await storage.get());
    migrateNaiConfig();
    setupPageHookBridge();
    createShell();
    await ingestPageData();
    await cleanupSelfCreator();
    applyEnhancements();
    setupAutosave();
    watchRoute();
    pushChatInjectConfig();
    pushShortcutsConfig();
    // page-hook이 늦게 준비될 수 있어 한 번 더 전달
    setTimeout(() => { pushChatInjectConfig(); pushShortcutsConfig(); }, 500);
    // 이미지 고정 토글은 클래스만 바뀌어 MutationObserver(childList/href)가 못 잡는다 —
    // 채팅 페이지에서만 가볍게 주기 점검해 [이미지 변경] 버튼을 제때 붙인다.
    setInterval(() => {
      if (/\/chat\//.test(location.pathname)) enhanceNaiChatTools();
    }, 900);
  }

  init().catch((error) => console.error("[Rofan Helper] init failed", error));
})();
