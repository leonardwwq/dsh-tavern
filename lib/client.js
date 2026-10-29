// DSH Tavern client: public projections only; persistence and game authority stay on the host.
window.__ModuleLoader__.load({
  id: "dsh-tavern-adventure",
  factory: (require) => {
    const React = require("react");
    const P = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const CSS = `
.tv-root{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.65;max-width:760px;display:flex;flex-direction:column;gap:14px}
.tv-root *{box-sizing:border-box}.tv-root h2,.tv-root h3,.tv-root p{margin:0}.tv-root h2{font-size:19px;line-height:1.4}.tv-root h3{font-size:14px}.tv-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}.tv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tv-between{justify-content:space-between}.tv-stack{display:flex;flex-direction:column;gap:10px}.tv-grow{flex:1;min-width:0}.tv-eyebrow{font-size:10px;font-weight:650;letter-spacing:.16em;color:var(--dsw-alias-label-tertiary)}
.tv-hero{padding:18px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:linear-gradient(135deg,var(--dsw-alias-bg-layer-2),var(--dsw-alias-bg-layer-3));display:flex;flex-direction:column;gap:8px}.tv-pill{border-radius:6px;background:var(--dsw-alias-fill-tsp-secondary);padding:2px 7px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.tv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.tv-card{border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-2);padding:13px;display:flex;flex-direction:column;gap:8px;overflow-wrap:anywhere}.tv-card.tv-selected{border-color:var(--dsw-alias-brand-primary)}.tv-card.tv-archived{opacity:.76}.tv-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.tv-description{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap}.tv-btn{font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 11px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;line-height:1.5}.tv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.tv-btn:disabled{opacity:.45;cursor:not-allowed}.tv-btn:focus-visible,.tv-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.tv-primary{background:var(--dsw-alias-label-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}.tv-primary:hover:not(:disabled){opacity:.86;background:var(--dsw-alias-label-primary)}.tv-danger{color:var(--dsw-alias-state-error-primary)}.tv-input{width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}.tv-empty{padding:23px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:11px;color:var(--dsw-alias-label-tertiary)}.tv-alert{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-size:12px;overflow-wrap:anywhere}.tv-error{color:var(--dsw-alias-state-error-primary)}.tv-notice{color:var(--dsw-alias-state-success-primary)}.tv-steps{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:10px}.tv-step{color:var(--dsw-alias-label-tertiary);font-size:12px}.tv-step.tv-current{color:var(--dsw-alias-label-primary);font-weight:600}.tv-divider{height:1px;background:var(--dsw-alias-border-l2);margin:2px 0}.tv-modal{width:min(720px,94vw)!important;max-width:none!important}.tv-modal .tv-root{max-height:68vh;overflow-y:auto;padding:2px}.tv-party{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.tv-member{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 8px;min-width:0;overflow-wrap:anywhere}.tv-member strong{display:block;font-size:13px}.tv-monogram{width:25px;height:25px;display:grid;place-items:center;border-radius:8px;margin-bottom:7px;background:var(--dsw-alias-fill-tsp-secondary);font-size:12px}.tv-opening{border-left:2px solid var(--dsw-alias-brand-primary);padding:4px 0 4px 13px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}.tv-chip{font:inherit;font-size:13px;height:28px;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:8px;padding:0 8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}.tv-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}.tv-chip:disabled{opacity:.5;cursor:default}.tv-badge{height:24px;max-width:210px;font-size:12px;background:var(--dsw-alias-fill-tsp-secondary)}.tv-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tv-check{display:flex;align-items:center;gap:7px;font-size:12px}.tv-confirm{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:13px;display:flex;flex-direction:column;gap:10px}.tv-file{display:none}@media(max-width:520px){.tv-party{grid-template-columns:repeat(2,minmax(0,1fr))}.tv-hero{padding:14px}.tv-grid{grid-template-columns:1fr}}
`;
    const store = { entries: new Map(), watches: new Map(), observations: new Map(), overlay: null, pending: "", error: "", notice: "" };
    const listeners = new Set();
    const controllers = new Set();
    let disposed = false;
    function notify() { if (!disposed) listeners.forEach((fn) => fn()); }
    function patch(values) { Object.assign(store, values); notify(); }
    function entry(sessionId) {
      const key = sessionId || "";
      if (!store.entries.has(key)) store.entries.set(key, { data: null, loading: false, error: "", request: null });
      return store.entries.get(key);
    }
    function useStore() {
      const [, update] = React.useState(0);
      React.useEffect(() => { const fn = () => update((n) => n + 1); listeners.add(fn); return () => listeners.delete(fn); }, []);
      return store;
    }
    function message(error) { return error && error.message ? error.message : "请求失败，请重试。"; }
    async function api(path, body, timeoutMs = 20000) {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch("/tavern/api/" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
        let result;
        try { result = await response.json(); } catch (_) { throw new Error("服务返回了无效数据（HTTP " + response.status + "）。"); }
        if (!response.ok || (result && result.ok === false)) {
          const error = new Error(result && typeof result.error === "string" ? result.error : "请求失败（HTTP " + response.status + "）。");
          error.code = result && result.code;
          throw error;
        }
        return result;
      } catch (error) {
        if (error && error.name === "AbortError") throw new Error("请求超时或已取消，请刷新状态后重试；不要重复创建冒险。");
        throw error;
      } finally { clearTimeout(timer); controllers.delete(controller); }
    }
    function validState(data) {
      if (!data || !Array.isArray(data.scripts) || !Array.isArray(data.campaigns) || typeof data.canStart !== "boolean") throw new Error("冒险状态格式不兼容，请更新插件后重试。");
      return data;
    }
    function refresh(sessionId) {
      const row = entry(sessionId);
      if (row.request) return row.request;
      row.loading = true;
      row.error = "";
      row.request = api("state" + (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : ""))
        .then(validState).then((data) => { if (!disposed) row.data = data; return data; })
        .catch((error) => { if (!disposed) row.error = message(error); return null; })
        .finally(() => { row.loading = false; row.request = null; notify(); });
      notify();
      return row.request;
    }
    function useData(sessionId, active = true, poll = false) {
      useStore();
      React.useEffect(() => {
        if (!active) return;
        const key = sessionId || "";
        const watch = store.watches.get(key) || { count: 0, poll: 0 };
        watch.count++; if (poll) watch.poll++;
        store.watches.set(key, watch);
        refresh(key);
        return () => { watch.count--; if (poll) watch.poll--; if (!watch.count) store.watches.delete(key); };
      }, [sessionId, active, poll]);
      return entry(sessionId);
    }
    function refreshVisible(pollOnly = false) {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      for (const [key, watch] of store.watches) if (!pollOnly || watch.poll > 0) refresh(key);
    }
    function scripts(data) { return data ? data.scripts : []; }
    function saves(data, script) {
      return data && script ? data.campaigns.filter((save) => save.scriptKey ? save.scriptKey === script.key : save.scriptId === script.id) : [];
    }
    function used(data, script) { return saves(data, script).length > 0; }
    function canChoose(sessionId, data) {
      return !!(sessionId && store.observations.get(sessionId) === true && data && data.canStart === true && data.dependencyReady === true && !data.binding);
    }
    function openPanel(sessionId) { patch({ overlay: { sessionId }, error: "", notice: "" }); refresh(sessionId); }
    function closePanel() { if (!store.pending) patch({ overlay: null, error: "", notice: "" }); }
    async function mutate(label, operation, success) {
      if (store.pending || disposed) return false;
      patch({ pending: label, error: "", notice: "" });
      let ok = false;
      try { await operation(); ok = true; if (!disposed) patch({ notice: success || "已保存" }); }
      catch (error) { if (!disposed) patch({ error: message(error) }); }
      finally {
        // Even a timed-out POST may have committed: always reconcile with host authority.
        if (!disposed) {
          const keys = new Set(store.watches.keys());
          if (store.overlay) keys.add(store.overlay.sessionId || "");
          await Promise.all(Array.from(keys, (key) => refresh(key)));
          patch({ pending: "" });
        }
      }
      return ok;
    }
    function button(label, onClick, disabled = false, primary = false, extra = {}) {
      return h("button", Object.assign({ type: "button", className: "tv-btn" + (primary ? " tv-primary" : ""), disabled: !!(disabled || store.pending), onClick }, extra), label);
    }
    function empty(text) { return h("div", { className: "tv-empty" }, text); }
    function Alert({ children, error = false }) { return h("div", { className: "tv-alert" + (error ? " tv-error" : ""), role: error ? "alert" : "status" }, children); }
    function Status({ row }) {
      return h(React.Fragment, null,
        row.loading && !row.data ? h(Alert, null, "正在读取本地冒险档案…") : null,
        row.error ? h(Alert, { error: true }, h("div", { className: "tv-row tv-between" }, h("span", null, row.error), button("重试", () => refresh(row.sessionId), row.loading))) : null,
        store.error ? h(Alert, { error: true }, store.error) : null,
        store.pending ? h(Alert, null, store.pending + "…请稍候") : store.notice ? h("div", { className: "tv-alert tv-notice", role: "status" }, store.notice) : null,
        row.data && row.data.dependencyReady !== true ? h(Alert, { error: true }, "角色养成依赖尚未就绪，暂时无法开始或推进冒险。请检查宿主插件状态。") : null);
    }
    function formatDate(value) {
      if (!value) return "尚未记录";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    function ScriptDetails({ script }) {
      return h("div", { className: "tv-stack" },
        h("div", { className: "tv-row" }, h("strong", null, script.title), h("span", { className: "tv-pill" }, "v" + script.version), script.archived ? h("span", { className: "tv-pill" }, "已归档") : null),
        h("p", { className: "tv-muted" }, (script.author ? "作者 · " + script.author + "　" : "") + "角色 · " + script.characterCount),
        h("p", { className: "tv-text" }, script.description || "这个剧本暂未提供简介。"),
        h("p", { className: "tv-muted" }, "剧本 ID · " + script.id));
    }
    async function encodeZip(file) {
      if (!file || !/\.zip$/i.test(file.name)) throw new Error("请选择 .zip 格式的剧本包。无需解压，也不支持其他格式。");
      if (!Number.isFinite(file.size) || file.size < 4) throw new Error("ZIP 文件为空或不完整。");
      if (file.size > 5 * 1024 * 1024) throw new Error("剧本包过大，最多导入 5 MiB 的 ZIP。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || !((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8))) throw new Error("文件不是有效的 ZIP 剧本包。");
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    }
    function ScriptManager({ data, compact = false }) {
      const fileRef = React.useRef(null);
      const [showArchived, setShowArchived] = React.useState(false);
      const [detail, setDetail] = React.useState("");
      const [deleting, setDeleting] = React.useState("");
      const [confirmation, setConfirmation] = React.useState(false);
      const list = scripts(data).filter((script) => showArchived || !script.archived);
      const selected = scripts(data).find((script) => script.key === detail);
      const target = scripts(data).find((script) => script.key === deleting);
      const importFile = (file) => mutate("导入剧本", async () => {
        const base64 = await encodeZip(file);
        await api("import", { name: file.name, base64 }, 90000);
      }, "剧本已导入，可以为新会话选择冒险。");
      return h("section", { className: "tv-stack", "aria-label": "剧本管理" },
        h("div", { className: "tv-row tv-between" }, h("div", null, h("h3", null, compact ? "本地剧本库" : "剧本管理"), h("p", { className: "tv-muted" }, "导入 ZIP · 保留版本 · 不提供可视化编辑")), button("＋ 导入 ZIP", () => fileRef.current && fileRef.current.click())),
        h("input", { ref: fileRef, className: "tv-file", type: "file", accept: ".zip,application/zip", disabled: !!store.pending, onChange: (event) => { const file = event.target.files && event.target.files[0]; event.target.value = ""; if (file) importFile(file); } }),
        h("label", { className: "tv-check" }, h("input", { type: "checkbox", checked: showArchived, disabled: !!store.pending, onChange: (event) => setShowArchived(event.target.checked) }), "显示归档剧本"),
        !data ? null : list.length === 0 ? empty(showArchived ? "还没有剧本。导入一个 ZIP，让故事开始。" : "暂无可用剧本。导入 ZIP，或显示归档剧本后恢复。") : h("div", { className: "tv-grid" }, list.map((script) => {
          const inUse = used(data, script);
          return h("article", { className: "tv-card" + (script.archived ? " tv-archived" : ""), key: script.key },
            h("div", { className: "tv-row tv-between" }, h("strong", null, script.title), h("span", { className: "tv-pill" }, script.archived ? "已归档" : "v" + script.version)),
            h("p", { className: "tv-description" }, script.description || "暂无简介"),
            h("p", { className: "tv-muted" }, (script.author || "匿名作者") + " · " + script.characterCount + " 位角色 · " + saves(data, script).length + " 个存档"),
            h("div", { className: "tv-row" }, button(detail === script.key ? "收起详情" : "详情", () => setDetail(detail === script.key ? "" : script.key)),
              button(script.archived ? "恢复" : "归档", () => mutate(script.archived ? "恢复剧本" : "归档剧本", () => api("archive", { scriptKey: script.key, archived: !script.archived }), script.archived ? "剧本已恢复" : "剧本已归档，已有存档仍可接续。")),
              button("删除", () => { setDeleting(script.key); setConfirmation(false); }, inUse, false, { className: "tv-btn tv-danger", title: inUse ? "剧本已被存档引用，不能删除" : "删除未使用的剧本" })));
        })),
        selected ? h("div", { className: "tv-card" }, h(ScriptDetails, { script: selected })) : null,
        target ? h("div", { className: "tv-confirm", role: "alertdialog", "aria-label": "确认删除剧本" },
          h("strong", null, "永久删除「" + target.title + "」？"),
          h("p", { className: "tv-muted" }, "仅从未被任何存档引用的剧本可以删除。此操作不可撤销；宿主会再次检查引用。"),
          h("label", { className: "tv-check" }, h("input", { type: "checkbox", checked: confirmation, disabled: !!store.pending, onChange: (event) => setConfirmation(event.target.checked) }), "我确认永久删除这个剧本版本"),
          h("div", { className: "tv-row" }, button("取消", () => setDeleting("")), button("确认永久删除", async () => {
            if (!confirmation || used(data, target)) return;
            if (await mutate("删除剧本", () => api("delete-script", { scriptKey: target.key }), "剧本已删除")) { setDeleting(""); setDetail(""); }
          }, !confirmation || used(data, target), false, { className: "tv-btn tv-danger" }))) : null);
    }
    function SettingsSection() {
      const row = useData("", true, true);
      return h("div", { className: "tv-root" },
        h("div", { className: "tv-hero" }, h("span", { className: "tv-eyebrow" }, "DSH TAVERN / 本地冒险档案"), h("h2", null, "让下一段对话，成为冒险。"), h("p", { className: "tv-muted" }, "你与三位独立行动的伙伴组成四人小队。NPC 会自主选择协助、挡伤、拒绝或离队；规则结算真实后果，DM 负责呈现。"), h("p", { className: "tv-muted" }, "在全新空白会话的输入框选择「地城冒险」，先选剧本，再新建或接续存档。绑定后不可切回普通会话或更换冒险。数据由本机宿主持久保存。")),
        h(Status, { row: Object.assign({ sessionId: "" }, row) }),
        h(ScriptManager, { data: row.data }));
    }
    function GamePanel({ data, sessionId }) {
      const campaign = data.campaign;
      const readOnly = !!data.binding.readOnly;
      if (!campaign) return h(Alert, { error: true }, "本会话已绑定冒险，但暂时无法读取存档。请刷新重试；不能切换为普通会话。");
      const player = campaign.player || {};
      const party = Array.isArray(campaign.party) ? campaign.party.slice(0, 3) : [];
      const scene = campaign.scene || {};
      const currentScript = scripts(data).find((script) => script.id === campaign.scriptId && String(script.version) === String(campaign.scriptVersion));
      const pause = () => mutate(campaign.paused ? "恢复冒险" : "暂停冒险", async () => {
        const fresh = await refresh(sessionId);
        if (!fresh || !fresh.binding || fresh.binding.readOnly || !fresh.campaign || fresh.campaign.completed || fresh.dependencyReady !== true) throw new Error("存档状态已变化，当前会话无法推进冒险。请查看最新状态。");
        await api("pause", { sessionId, paused: !campaign.paused });
      }, campaign.paused ? "冒险已恢复，请在主会话中继续行动。" : "冒险已暂停；会话仍永久绑定此存档。");
      return h("div", { className: "tv-stack" },
        readOnly ? h(Alert, null, h("strong", null, "已在其他会话接续"), h("p", null, "这个旧会话仅供回看，不能继续推进、换存档或切回普通聊天。请前往接续后的新会话。")) : null,
        h("div", { className: "tv-hero" }, h("div", { className: "tv-row tv-between" }, h("span", { className: "tv-eyebrow" }, "ADVENTURE / 永久绑定"), h("span", { className: "tv-pill" }, readOnly ? "只读回看" : campaign.completed ? "已完结" : campaign.paused ? "已暂停" : "冒险中")),
          h("h2", null, campaign.title), h("p", { className: "tv-muted" }, (currentScript ? currentScript.title : "剧本") + " · v" + campaign.scriptVersion + " · 第 " + (Number.isFinite(campaign.turnIndex) ? campaign.turnIndex : 0) + " 轮")),
        h("div", { className: "tv-row tv-between" }, h("h3", null, "四人小队"), h("span", { className: "tv-muted" }, "你 + 3 位 NPC")),
        h("div", { className: "tv-party" },
          h("div", { className: "tv-member" }, h("span", { className: "tv-monogram", "aria-hidden": true }, "你"), h("strong", null, player.name || "冒险者"), h("span", { className: "tv-muted" }, "玩家 · HP " + (player.hp == null ? "—" : player.hp) + " / " + (player.maxHp == null ? "—" : player.maxHp))),
          [0, 1, 2].map((index) => { const npc = party[index]; const status = npc && npc.status === "left" ? "离队" : npc && npc.status === "missing" ? "失踪" : ""; const condition = npc && Array.isArray(npc.condition) ? npc.condition.join("、") : ""; const label = [npc ? npc.role || "NPC 伙伴" : "NPC", status, condition].filter(Boolean).join(" · "); return h("div", { className: "tv-member", key: npc ? npc.id : index }, h("span", { className: "tv-monogram", "aria-hidden": true }, npc && npc.name ? Array.from(npc.name)[0] : "◇"), h("strong", null, npc ? npc.name : "伙伴待就绪"), h("span", { className: "tv-muted" }, label), npc && npc.lastAction && npc.lastAction.sceneId === scene.id && typeof npc.lastAction.text === "string" ? h("small", { className: "tv-muted" }, "自主行动：" + npc.lastAction.text) : null); })),
        h("div", { className: "tv-card" }, h("span", { className: "tv-eyebrow" }, "CURRENT SCENE / 当前场景"), h("h3", null, scene.place || "未知地点"), scene.opening ? h("p", { className: "tv-opening" }, scene.opening) : h("p", { className: "tv-muted" }, "场景开场尚未就绪，请在主会话查看 DM 叙事。")),
        h("p", { className: "tv-muted" }, readOnly ? "本面板仅展示公开冒险状态，不包含 NPC 私密记忆或 DM 隐藏信息。" : campaign.completed ? "这段冒险已经完结。可以保留会话回看；开启另一段故事请新建空白会话。" : "直接在主会话描述你的行动，由 DM 裁定并协调三位伙伴。此面板不另开聊天，也不展示任何私密角色数据。"),
        !readOnly && !campaign.completed ? h("div", { className: "tv-row" }, button(campaign.paused ? "继续冒险" : "暂停冒险", pause, data.dependencyReady !== true), h("span", { className: "tv-muted" }, "暂停不会解除绑定")) : null);
    }
    function Picker({ data, sessionId }) {
      const [scriptKey, setScriptKey] = React.useState("");
      const [step, setStep] = React.useState(1);
      const [title, setTitle] = React.useState("");
      const [takeover, setTakeover] = React.useState("");
      const [confirmed, setConfirmed] = React.useState(false);
      const [manager, setManager] = React.useState(false);
      const script = scripts(data).find((item) => item.key === scriptKey);
      const compatible = saves(data, script);
      const target = compatible.find((save) => save.id === takeover);
      const allowed = canChoose(sessionId, data);
      const commit = (save, takingOver) => mutate(save ? "接续冒险" : "创建冒险", async () => {
        const fresh = await refresh(sessionId);
        if (!canChoose(sessionId, fresh)) throw new Error("此会话已不再是可绑定的空白会话。请新建会话后再选择冒险。");
        const current = scripts(fresh).find((item) => item.key === scriptKey);
        if (!current) throw new Error("剧本已不存在，请重新选择。");
        if (!save && current.archived) throw new Error("剧本已归档，请恢复后再创建冒险。");
        if (save) {
          const latest = saves(fresh, current).find((item) => item.id === save.id);
          if (!latest) throw new Error("存档已变化，请重新选择。");
          // A newly acquired owner requires a new explicit confirmation; never silently escalate takeover.
          if (!takingOver && latest.ownerSessionId && latest.ownerSessionId !== sessionId) { setTakeover(latest.id); setConfirmed(false); throw new Error("此存档已有所属会话，请明确确认接管后再继续。"); }
          await api("attach", { sessionId, campaignId: save.id, takeover: !!takingOver }, 90000);
        } else await api("start", Object.assign({ sessionId, scriptKey }, title.trim() ? { title: title.trim() } : {}), 90000);
        setTakeover("");
      }, save ? "存档已接续。请在主会话与 DM 继续冒险。" : "冒险已创建。请在主会话查看 DM 开场；本面板也保留当前场景引言。");
      return h("div", { className: "tv-stack" },
        h("div", { className: "tv-steps", "aria-label": "选择步骤" }, h("span", { className: "tv-step" + (step === 1 ? " tv-current" : "") }, "01 选择剧本"), h("span", { className: "tv-muted" }, "→"), h("span", { className: "tv-step" + (step === 2 ? " tv-current" : "") }, "02 选择存档")),
        h("p", { className: "tv-muted" }, "冒险只从全新空白会话开始。确认后，本会话将永久绑定同一个存档，无法切回普通聊天。"),
        !allowed && data ? h(Alert, { error: true }, "当前会话暂不可开始冒险：仅未发送过消息、未绑定的空白会话可选；宿主状态为最终依据。") : null,
        step === 1 ? h(React.Fragment, null,
          h("div", { className: "tv-row tv-between" }, h("h3", null, "先挑选一本故事"), button(manager ? "收起管理" : "导入 / 管理剧本", () => setManager(!manager))),
          manager ? h(ScriptManager, { data, compact: true }) : null,
          scripts(data).length ? h("div", { className: "tv-grid" }, scripts(data).map((item) => h("article", { key: item.key, className: "tv-card" + (item.key === scriptKey ? " tv-selected" : "") },
            h("div", { className: "tv-row tv-between" }, h("strong", null, item.title), h("span", { className: "tv-pill" }, item.archived ? "归档 · 仅接续" : "v" + item.version)),
            h("p", { className: "tv-description" }, item.description || "暂无简介"), h("p", { className: "tv-muted" }, (item.author || "匿名作者") + " · " + item.characterCount + " 位角色"),
            button(item.key === scriptKey ? "已选择" : "选择此剧本", () => { setScriptKey(item.key); setTakeover(""); }, !allowed || (item.archived && !saves(data, item).length), item.key === scriptKey)))) : empty("还没有剧本。先导入一个 ZIP 剧本包，再选择存档。"),
          script ? h("div", { className: "tv-card" }, h(ScriptDetails, { script })) : null,
          h("div", { className: "tv-row" }, button("下一步：选择存档", () => { setStep(2); setTitle(""); }, !script || !allowed, true))) : h(React.Fragment, null,
          h("div", { className: "tv-row tv-between" }, h("h3", null, script ? script.title + " · v" + script.version : "剧本已不可用"), button("返回选择剧本", () => { setStep(1); setTakeover(""); })),
          !script ? h(Alert, { error: true }, "所选剧本已被移除，请返回重新选择。") : h(React.Fragment, null,
            h("div", { className: "tv-card" }, h("h3", null, "开启全新冒险"), h("p", { className: "tv-muted" }, script.archived ? "此剧本已归档，只能接续已有存档。恢复剧本后可新建。" : "创建独立存档，不影响任何已有冒险。你将与三位伙伴共同出发。"),
              h("label", { className: "tv-stack" }, h("span", { className: "tv-muted" }, "冒险名称（选填）"), h("input", { className: "tv-input", value: title, maxLength: 80, placeholder: "例如：雾门后的第一夜", disabled: !!store.pending || script.archived || !allowed, onChange: (event) => setTitle(event.target.value) })),
              h("div", null, button("创建并永久绑定", () => commit(null, false), !allowed || script.archived, true))),
            h("div", { className: "tv-divider" }), h("h3", null, "或接续已有存档"),
            compatible.length ? h("div", { className: "tv-stack" }, compatible.map((save) => h("article", { key: save.id, className: "tv-card" }, h("div", { className: "tv-row tv-between" }, h("strong", null, save.title), h("span", { className: "tv-pill" }, save.status === "completed" ? "已完结" : save.ownerSessionId ? "已有所属会话" : "可接续")),
              h("p", { className: "tv-muted" }, "更新于 " + formatDate(save.updatedAt) + (save.sceneId ? " · 场景 " + save.sceneId : "")),
              h("div", null, button(save.ownerSessionId && save.ownerSessionId !== sessionId ? "接续到此会话…" : "接续并永久绑定", () => {
                if (save.ownerSessionId && save.ownerSessionId !== sessionId) { setTakeover(save.id); setConfirmed(false); }
                else commit(save, false);
              }, !allowed))))) : empty("这个剧本版本还没有存档，可以从全新冒险开始。"))),
        target ? h("div", { className: "tv-confirm", role: "alertdialog", "aria-label": "确认接管存档" }, h("strong", null, "将「" + target.title + "」接续到此新会话？"),
          h("p", null, "原所属会话将永久失去推进权限，显示「已在其他会话接续」并仅供回看。同一个存档任何时候都只有一个会话可写入。"),
          h("label", { className: "tv-check" }, h("input", { type: "checkbox", checked: confirmed, disabled: !!store.pending, onChange: (event) => setConfirmed(event.target.checked) }), "我确认原会话放弃控制，由此会话接管"),
          h("div", { className: "tv-row" }, button("取消", () => setTakeover("")), button("确认接管并绑定", () => { if (confirmed) commit(target, true); }, !confirmed || !allowed, true))) : null);
    }
    function Overlay() {
      const state = useStore();
      const sessionId = state.overlay ? state.overlay.sessionId : "";
      const row = useData(sessionId, !!state.overlay, true);
      if (!state.overlay) return null;
      return h(P.Modal, { open: true, onClose: closePanel, title: row.data && row.data.binding ? "冒险手札" : "为新会话选择冒险", className: "tv-modal", footer: h(React.Fragment, null, button("刷新", () => refresh(sessionId), row.loading), button("关闭", closePanel)) },
        h("div", { className: "tv-root", "aria-busy": !!(row.loading || state.pending) }, h(Status, { row: Object.assign({ sessionId }, row) }),
          row.data && row.data.binding ? h(GamePanel, { key: sessionId, data: row.data, sessionId }) : row.data ? h(Picker, { key: sessionId, data: row.data, sessionId }) : null));
    }
    function SessionChip(props) {
      const readSession = props.useSession;
      const session = readSession ? readSession((value) => value) : props.session;
      const sessionId = props.sessionId;
      const blank = !!(session && session.blank && !session.promptAttempted);
      // Keep the live blank observation even when the chip becomes hidden after first input.
      if (sessionId) store.observations.set(sessionId, blank);
      const row = useData(sessionId, !!sessionId, false);
      if (!sessionId) return null;
      const binding = row.data && row.data.binding;
      if (binding) return h("button", { type: "button", className: "tv-chip", onClick: () => openPanel(sessionId), title: binding.readOnly ? "已在其他会话接续" : "查看永久绑定的冒险" }, h("span", { "aria-hidden": true }, "◇"), binding.readOnly ? "已在其他会话接续" : "冒险手札");
      if (!blank) return null;
      return h("button", { type: "button", className: "tv-chip", onClick: () => openPanel(sessionId), disabled: !!store.pending, title: "先选剧本，再新建或接续冒险" }, h("span", { "aria-hidden": true }, "◇"), "地城冒险", h("span", { "aria-hidden": true }, "⌄"));
    }
    function HeaderBadge(props) {
      const row = useData(props.sessionId, !!props.sessionId, false);
      if (!props.sessionId || !row.data || !row.data.binding) return null;
      const readOnly = row.data.binding.readOnly;
      return h("button", { type: "button", className: "tv-chip tv-badge", onClick: () => openPanel(props.sessionId), title: readOnly ? "已在其他会话接续 · 只读" : "查看冒险手札" }, h("span", { "aria-hidden": true }, "◇"), h("span", { className: "tv-truncate" }, readOnly ? "已在其他会话接续" : row.data.campaign ? row.data.campaign.title : "冒险手札"));
    }
    async function apply(ctx) {
      disposed = false;
      const slots = ctx.get("slots");
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin-css", "dsh-tavern/styles");
        style.textContent = CSS;
        document.head.appendChild(style);
        const changed = () => refreshVisible();
        const visible = () => { if (document.visibilityState !== "hidden") refreshVisible(); };
        window.addEventListener("dsh-tavern:changed", changed);
        document.addEventListener("visibilitychange", visible);
        const timer = setInterval(() => refreshVisible(true), 10000);
        return () => {
          disposed = true;
          clearInterval(timer);
          window.removeEventListener("dsh-tavern:changed", changed);
          document.removeEventListener("visibilitychange", visible);
          controllers.forEach((controller) => controller.abort());
          controllers.clear();
          style.remove();
          listeners.clear();
          store.watches.clear();
          store.entries.clear();
          store.observations.clear();
          store.overlay = null;
          store.pending = "";
        };
      });
      if (!slots) return;
      const reg = (name, options, component) => {
        try { return slots.register(Object.assign({ name }, options), component); }
        catch (error) { console.error("[dsh-tavern] 插槽注册失败：" + name, error); return () => {}; }
      };
      slots.inject("settings.section", () => reg("settings.section", { id: "dsh-tavern", label: "地城冒险", order: 23 }, SettingsSection));
      slots.inject("shell.overlay", () => reg("shell.overlay", { id: "dsh-tavern-panel", order: 105 }, Overlay));
      slots.inject("conversation.input.left", () => reg("conversation.input.left", { id: "dsh-tavern-chip", order: 110 }, SessionChip));
      slots.inject("conversation.session.header.utilities", () => reg("conversation.session.header.utilities", { id: "dsh-tavern-badge", order: 110 }, HeaderBadge));
    }
    return { apply, inject: ["slots"] };
  }
});
