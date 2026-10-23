import * as m from "mupdf";

function paintedBounds({ method, args, plan }) {
  if (plan) return m.Rect.transform(plan.box, plan.matrix);
  switch (method) {
    case "fillPath": case "clipPath":
      return args[0].getBounds(null, args[2]);
    case "strokePath": case "clipStrokePath":
      return args[0].getBounds(args[1], args[2]);
    case "fillImage": case "fillImageMask": case "clipImageMask":
      return m.Rect.transform([0, 0, 1, 1], args[1]);
    // Native Text bounds are unreliable for some embedded subset fonts.
    // Retain text unless an enclosing, explicit geometric clip excludes it.
    default: return null;
  }
}

// Keep every state operation. An entire clip scope may be skipped only if its
// group/mask/tile context is unchanged at the matching pop (no crossed scopes).
export function indexRenderBounds(commands) {
  const clips = [], contexts = [];
  let tileDepth = 0;
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i], { method } = command;
    const bounds = tileDepth ? null : paintedBounds(command);
    command.bounds = bounds?.every(Number.isFinite) ? bounds : null;
    if (method.startsWith("clip")) clips.push({ index: i, context: contexts.at(-1) });
    else if (["beginGroup", "beginMask", "beginTile"].includes(method)) {
      contexts.push(i);
      if (method === "beginTile") tileDepth++;
    } else if (["endGroup", "endMask", "endTile"].includes(method)) {
      contexts.pop();
      if (method === "endTile") tileDepth--;
      if (method === "endMask") clips.push({ index: null });
    } else if (method === "popClip") {
      const clip = clips.pop();
      if (clip?.index != null && clip.context === contexts.at(-1))
        commands[clip.index].skipTo = i;
    }
    command.canCull = Boolean(command.bounds) && !method.startsWith("clip");
  }
}

export function outside(bounds, viewport) {
  return bounds[2] < viewport[0] || bounds[0] > viewport[2] ||
    bounds[3] < viewport[1] || bounds[1] > viewport[3];
}
