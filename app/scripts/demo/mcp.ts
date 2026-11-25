// A minimal client for a stdio MCP server that is set up in ~/.claude.json, so the demo scripts
// can use the same ElevenLabs server Claude Code is given, with the same settings.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };

function findServer(name: string): ServerConfig {
	const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
	const seen: ServerConfig[] = [];
	const walk = (o: unknown): void => {
		if (!o || typeof o !== "object") return;
		for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
			if (k === "mcpServers" && v && typeof v === "object" && name in (v as object)) seen.push((v as Record<string, ServerConfig>)[name]);
			else walk(v);
		}
	};
	walk(config);
	if (!seen.length) throw new Error(`No MCP server called ${name} in ~/.claude.json`);
	return seen[0];
}

export type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

export class Mcp {
	private child: ChildProcessWithoutNullStreams;
	private next = 1;
	private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private buf = "";

	constructor(name: string, extraEnv: Record<string, string> = {}) {
		const cfg = findServer(name);
		this.child = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...cfg.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stderr.on("data", () => {});
		this.child.stdout.on("data", (d: Buffer) => {
			this.buf += d.toString();
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl).trim();
				this.buf = this.buf.slice(nl + 1);
				if (!line.startsWith("{")) continue;
				const msg = JSON.parse(line);
				const w = this.waiting.get(msg.id);
				if (!w) continue;
				this.waiting.delete(msg.id);
				if (msg.error) w.reject(new Error(msg.error.message));
				else w.resolve(msg.result);
			}
		});
	}

	private request(method: string, params: unknown): Promise<any> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
			this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	async start(): Promise<void> {
		await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dj-utilities-demo", version: "1" } });
		this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
	}

	tools(): Promise<{ tools: { name: string; description: string; inputSchema: unknown }[] }> {
		return this.request("tools/list", {});
	}

	async call(name: string, args: Record<string, unknown>): Promise<string> {
		const res: ToolResult = await this.request("tools/call", { name, arguments: args });
		const text = res.content.map((c) => c.text ?? "").join("\n");
		if (res.isError) throw new Error(`${name}: ${text}`);
		return text;
	}

	stop(): void {
		this.child.kill();
	}
}
