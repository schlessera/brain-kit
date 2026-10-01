import { z } from "zod";
import { ALL_SOURCES, RETIRED_SOURCES } from "./types.js";

/** Shared by settings load/save and positional selection; never drop a name. */
export const boardNameSchema = z.string().superRefine((name, ctx) => {
  if ((ALL_SOURCES as readonly string[]).includes(name)) return;
  const reason = Object.hasOwn(RETIRED_SOURCES, name)
    ? `${name} was retired: ${RETIRED_SOURCES[name]}. Remove it from the selection.`
    : `Unknown sources: ${name}. Correct the name or remove it from the selection.`;
  ctx.addIssue({ code: "custom", message: `${reason} Valid: ${ALL_SOURCES.join(", ")}` });
});
