import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

export const sessionReplayRenderSchema = yupObject({
  id: yupString().defined(),
  session_replay_id: yupString().defined(),
  session_replay_segment_id: yupString().defined().meta({ openapiField: { description: "The tab (segment) of the replay that was rendered." } }),
  status: yupString().oneOf(["queued", "rendering", "succeeded", "failed"]).defined(),
  progress: yupNumber().nullable().defined().meta({ openapiField: { description: "Fraction of frames rendered so far (0 to 1), or null before rendering starts." } }),
  options: yupObject({
    fps: yupNumber().defined(),
    speed: yupNumber().defined(),
    skip_inactivity: yupBoolean().defined(),
  }).defined(),
  error_message: yupString().nullable().defined(),
  created_at_millis: yupNumber().defined(),
  started_at_millis: yupNumber().nullable().defined(),
  finished_at_millis: yupNumber().nullable().defined(),
  video: yupObject({
    url: yupString().defined().meta({ openapiField: { description: "Short-lived download URL for the MP4. Fetch the render again for a fresh one." } }),
    url_expires_at_millis: yupNumber().defined(),
    byte_length: yupNumber().defined(),
    width: yupNumber().defined(),
    height: yupNumber().defined(),
    duration_ms: yupNumber().defined(),
  }).nullable().defined(),
}).defined();
