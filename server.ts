import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = express();
app.use(cors());

// ==========================================
// 🚀 1. INITIALIZATION
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
// @ts-ignore
const stripe = new Stripe(stripeKey || 'sk_test_dummy', { apiVersion: '2023-10-16' });

/**
 * 🚩 PRODUCTION UPGRADE: 
 * Switching to "gemini-2.0-flash". 
 * This model is the fastest and most advanced for architectural tasks.
 * Once billing is linked in Google Cloud, regional and quota errors will resolve.
 */
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim(); 
const GEMINI_MODEL = "gemini-2.0-flash"; 
const APP_ID = 'mcp-studio-v1';

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        if (getApps().length === 0) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            initializeApp({ credential: cert(serviceAccount) });
        }
        db = getFirestore();
        db.settings({ ignoreUndefinedProperties: true });
    }
} catch (e: any) { console.error("❌ Firebase Init Failed:", e.message); }

// ==========================================
// 📡 2. MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    if (req.method === 'POST') console.log(`[REQ] ${req.path}`);
    if (req.path.startsWith('/messages/') || req.path === '/api/webhook/stripe') {
        next(); 
    } else {
        express.json()(req, res, next);
    }
});

// ==========================================
// 🪄 MAGIC SUGGEST (Batching Engine)
// ==========================================
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini Key missing." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "Endpoints required." });

    console.log(`[Magic] Analyzing ${endpoints.length} endpoints via ${GEMINI_MODEL}...`);

    try {
        // CHUNKING: We split large schemas into groups of 20
        const CHUNK_SIZE = 20;
        const chunks = [];
        for (let i = 0; i < endpoints.length; i += CHUNK_SIZE) {
            chunks.push(endpoints.slice(i, i + CHUNK_SIZE));
        }

        let allSuggestions: string[] = [];
        const systemPrompt = `You are an AI Tool Architect. Suggest the 3-5 most useful endpoints from the provided list for an AI agent.
        CRITICAL: Return valid JSON. Format: {"suggestions": ["METHOD:PATH"]}`;

        for (const [index, chunk] of chunks.entries()) {
            console.log(`[Magic] Processing batch ${index + 1}/${chunks.length}...`);
            
            const schemaSummary = chunk.map((e: any) => `- ID: "${e.id}" | Description: ${e.description}`).join('\n');
            const userPrompt = `List the best tools from this chunk:\n\n${schemaSummary}`;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
            
            const result = await axios.post(url, {
                contents: [{ parts: [{ text: userPrompt }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            });

            const aiRaw = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (aiRaw) {
                const parsed = JSON.parse(aiRaw);
                const batchSuggestions = (parsed.suggestions || []).map((s: string) => s.replace(/"/g, '').trim());
                allSuggestions = [...allSuggestions, ...batchSuggestions];
            }

            // Small delay to ensure we don't hit "Requests Per Minute" limits
            if (chunks.length > 1 && index < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        const validIds = endpoints.map((e: any) => e.id);
        const matched = allSuggestions.filter((s: string) => validIds.includes(s));
        
        res.json({ suggestions: matched });

    } catch (error: any) {
        const msg = error.response?.data?.error?.message || error.message;
        console.error("Magic Suggest Error:", msg);
        res.status(500).json({ suggestions: [], error: `Gemini Error: ${msg}` });
    }
});

// ==========================================
// 🚀 DEPLOYMENT & SSE LOGIC (Preserved)
// ==========================================
async function getDeployment(serverId: string) {
    if (!db) return null;
    const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
    return doc.exists ? doc.data() : null;
}

app.post('/api/deploy', async (req, res) => {
    try {
        const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
        const serverId = uuidv4();
        const config = { apiKey, endpoints, baseUrl: baseUrl.trim(), piiMasking: !!piiMasking, createdAt: new Date().toISOString() };
        if (db) await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
        const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
    } catch (err: any) { res.status(500).json({ error: "Deploy Error", details: err.message }); }
} );

const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    if (!vaultData) return res.status(404).send("Not found.");
    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);
    const mcpServer = new Server({ name: "MCP-Studio", version: "1.4.0" }, { capabilities: { tools: {} } });
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (vaultData.endpoints || []).map((ep: any) => ({
            name: `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase(),
            description: ep.description || `Call ${ep.method} ${ep.path}`,
            inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
        }))
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
        const toolName = req.params.name.toLowerCase();
        const ep = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        if (!ep) throw new Error("Tool not found.");
        const resp = await axios({ method: ep.method, url: `${vaultData.baseUrl}${ep.path}`, headers: { 'Authorization': `Bearer ${vaultData.apiKey}` } });
        return { content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }] };
    });
    await mcpServer.connect(transport);
});

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (transport) await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MCP Proxy Live (v1.4.0) with ${GEMINI_MODEL}`));