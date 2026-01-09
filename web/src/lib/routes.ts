export const routes = {
  user: "/",
  login: "/login",
  admin: "/admin",
  call: "/call",
};

export type RouteKey = keyof typeof routes;

export function isRoute(pathname: string, key: RouteKey) {
  return pathname === routes[key];
}
