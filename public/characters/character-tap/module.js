const packageId = "hoc-core/character-tap";
const fullPortrait = "full-portrait";
const regionParameters = { type: "object", properties: { id: { type: "string", minLength: 1 } }, additionalProperties: false };
const empty = { type: "object", additionalProperties: false };
const declaration = (id, returnType) => ({ id, apiVersion: 1, title: id, description: `角色交互事实：${id}`, returnType, dependencies: ["event"], parameters: empty });
const tap = event => event?.type === `${packageId}#tap` && event.apiVersion === 1;
const counters = ["round-count", "consecutive-count", "total-count"];
const primitives = [...counters.map((id, i) => ({ ...declaration(id, "number"), read: c => c.presentation?.[packageId]?.[["roundCount", "consecutiveCount", "totalCount"][i]] })), ...["x", "y", "region"].map(id => ({ ...declaration(id, id === "region" ? "string" : "number"), parameters: id === "region" ? regionParameters : empty, read: (c, args = {}) => {
  if (!tap(c.event)) return undefined;
  if (id !== "region" || args.id === undefined) return c.event.data[id];
  if (args.id === fullPortrait) return c.event.data.x !== null && c.event.data.y !== null ? fullPortrait : null;
  return c.event.data.region === args.id ? args.id : null;
} }))];
function contains(r, x, y) {
  if (r.shape === "rectangle") return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  let inside = false;
  for (let i = 0, j = r.points.length - 1; i < r.points.length; j = i++) {
    const a = r.points[j], b = r.points[i];
    if (Math.abs((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) <= 1e-10 && x >= Math.min(a.x, b.x) - 1e-10 && x <= Math.max(a.x, b.x) + 1e-10 && y >= Math.min(a.y, b.y) - 1e-10 && y <= Math.max(a.y, b.y) + 1e-10) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function createTapSource(attachments) {
  return (context, signal) => {
    let state = context.getPresentation();
    const match = context.getMatch();
    state = { ...state, consecutiveCount: 0 };
    if (!context.restored) state = { roundIndex: match.roundIndex, roundCount: 0, consecutiveCount: 0, totalCount: 0 };
    else if (state.roundIndex !== match.roundIndex) state = { ...state, roundIndex: match.roundIndex, roundCount: 0 };
    context.setPresentation(state);
    const releaseEvents = context.subscribeDialogueEvents(event => {
      if (tap(event)) return;
      const roundIndex = context.getMatch().roundIndex;
      state = { ...state, consecutiveCount: 0, ...(roundIndex !== state.roundIndex ? { roundIndex, roundCount: 0 } : {}) };
      context.setPresentation(state);
    });
    const releaseInteraction = context.subscribeCharacterInteraction(input => {
      if (signal.aborted) return;
      const regions = attachments
        .filter(a => a.characterId === input.characterId && a.packageId === input.image.packageId)
        .flatMap(a => a.images.filter(i => i.image === input.image.path).flatMap(i => i.regions));
      const region = input.x === null || input.y === null ? null
        : regions.find(r => contains(r, input.x, input.y))?.id ?? fullPortrait;
      state = { ...state, roundCount: state.roundCount + 1, consecutiveCount: state.consecutiveCount + 1, totalCount: state.totalCount + 1 };
      context.setPresentation(state);
      context.publish("tap", 1, { actor: "opponent", x: input.x, y: input.y, region });
    });
    const release = () => { releaseEvents(); releaseInteraction(); };
    signal.addEventListener("abort", release, { once: true });
    return () => { signal.removeEventListener("abort", release); release(); };
  };
}
export function register() {
  let attachments = [];
  return {
    dialoguePrimitives: primitives,
    handlers: [{ type: "plugin.character-tap", apiVersions: [2], parse(value, context) {
      const character = context.dependencies.get(value.characterResourceId);
      if (!character?.metadata?.id) throw Error("拍一拍附件必须引用同包角色资源");
      const ids = new Set(value.regions);
      if (ids.has(fullPortrait) || ids.size !== value.regions.length) throw Error("区域 ID 必须唯一且不能重定义 full-portrait");
      if (value.images.some(i => i.regions.some(r => !ids.has(r.id)))) throw Error("图片标定引用了未声明区域");
      return { ...value, characterId: character.metadata.id };
    } }],
    createRuntime(extensions) {
      attachments = (extensions["plugin.character-tap"] ?? []).map(e => ({ ...e.value, packageId: e.packageId }));
      return {};
    },
    mountDialogueSource(context, signal) { return createTapSource(attachments)(context, signal); }
  };
}
