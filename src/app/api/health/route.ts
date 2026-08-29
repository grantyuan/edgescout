// GET /api/health — service status: LLM mode (live/mock) + network.
import { LLM } from "@/lib/config";

export async function GET() {
  return Response.json({
    ok: true,
    network: "somnia-testnet",
    llm: LLM.enabled ? { mode: "live", model: LLM.model } : { mode: "mock" },
  });
}
