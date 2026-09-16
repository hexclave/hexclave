import { CrudTypeOf, createCrud } from "../../crud";
import { yupBoolean, yupMixed, yupNumber, yupObject, yupString } from "../../schema-fields";
import { geoInfoSchema } from "../../utils/geo";


// Create
export const sessionsCrudServerCreateSchema = yupObject({
  user_id: yupString().uuid().defined(),
  expires_in_millis: yupNumber().max(1000 * 60 * 60 * 24 * 367).default(1000 * 60 * 60 * 24 * 365),
  is_impersonation: yupBoolean().default(false),
}).defined();


export const sessionsCreateOutputSchema = yupObject({
  refresh_token: yupString().defined(),
  access_token: yupString().defined(),
}).defined();


export const sessionsCrudReadSchema = yupObject({
  id: yupString().defined(),
  user_id: yupString().uuid().defined(),
  created_at: yupNumber().defined(),
  is_impersonation: yupBoolean().defined(),
  // Name of the AI agent this session was minted for via agent auth, or null for regular sessions.
  agent_name: yupString().nullable().defined(),
  last_used_at: yupNumber().optional(),
  is_current_session: yupBoolean(),
  // TODO move this to a shared type
  // TODO: what about if not trusted?
  last_used_at_end_user_ip_info: geoInfoSchema.optional(),
}).defined();


// Delete
export const sessionsCrudDeleteSchema = yupMixed();


export const sessionsCrud = createCrud({
  // serverCreateSchema: sessionsCrudServerCreateSchema,
  serverReadSchema: sessionsCrudReadSchema,
  serverDeleteSchema: sessionsCrudDeleteSchema,
  clientReadSchema: sessionsCrudReadSchema,
  clientDeleteSchema: sessionsCrudDeleteSchema,
  docs: {
    serverList: {
      summary: "List sessions",
      description: "List all sessions for the current user.",
      tags: ["Sessions"],
    },
    serverDelete: {
      summary: "Delete session",
      description: "Delete a session by ID.",
      tags: ["Sessions"],
    },
    clientList: {
      summary: "List sessions",
      description: "List all sessions for the current user.",
      tags: ["Sessions"],
    },
    clientDelete: {
      summary: "Delete session",
      description: "Delete a session by ID.",
      tags: ["Sessions"],
    },
  },
});
export type SessionsCrud = CrudTypeOf<typeof sessionsCrud>;
