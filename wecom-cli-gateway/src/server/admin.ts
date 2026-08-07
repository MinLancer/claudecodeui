import type { FastifyInstance } from "fastify";

export interface AdminState {
  getBots(): Array<{ id: string; timeout: number; allowedUsers: string[]; defaultCli: string }>;
  updateBot(id: string, patch: { timeout?: number; allowedUsers?: string[]; defaultCli?: string }): void;
}

export function registerAdmin(app: FastifyInstance, state: AdminState) {
  // 查看所有 bot 配置
  app.get("/admin/bots", async () => state.getBots());
  // 修改运行时可变项:超时/白名单/默认CLI
  app.post("/admin/bots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { timeout?: number; allowedUsers?: string[]; defaultCli?: string };
    try {
      state.updateBot(id, body);
      return { status: "ok" };
    } catch (e) {
      return reply.code(400).send({ error: String(e) });
    }
  });
}
