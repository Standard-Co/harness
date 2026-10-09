// Routes the kernel's `host_request` events by the family prefix of their
// type (`refine.run` → `refine`). An unknown type throws, which the kernel
// turns into a RuntimeError in the calling cell.

import type { HostRequestHandler } from "./kernel/extension.ts";

export function routeHostRequests(routes: Readonly<Record<string, HostRequestHandler>>): HostRequestHandler {
	return async (origin, data, context) => {
		const type = typeof data.type === "string" ? data.type : "";
		const family = type.split(".")[0] ?? "";
		const handler = Object.hasOwn(routes, family) ? routes[family] : undefined;
		if (handler === undefined) {
			const known = Object.keys(routes).map((family) => `${family}.*`).join(", ");
			throw new Error(`host request ${type === "" ? "(untyped)" : type} is not supported by this host (it answers ${known})`);
		}
		return handler(origin, data, context);
	};
}
