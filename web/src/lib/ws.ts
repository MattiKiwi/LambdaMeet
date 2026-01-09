export function buildWsUrl(apiBase: string, token: string, meetingId: string) {
  const wsBase = apiBase.replace(/^http/, "ws").replace(/\/$/, "");
  const url = new URL(wsBase + "/ws");
  url.searchParams.set("token", token);
  url.searchParams.set("meetingId", meetingId);
  return url.toString();
}
