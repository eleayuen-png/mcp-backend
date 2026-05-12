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

// ==========================================
// 🚀 CORS FIX FOR GITHUB PAGES
// ==========================================
// This explicitly tells the browser that your frontend is allowed to talk to this backend
app.use(cors({
    origin: '*', // Allows all domains to connect
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));
app.options(/.*/, cors()); // Forces Express to respond correctly to Pre-flight checks

// ==========================================
// 1. INITIALIZATION
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
// @ts-ignore
const stripe = new Stripe(stripeKey || 'sk_test_dummy', { apiVersion: '2023-10-16' });

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim(); 
const GEMINI_MODEL = "gemini-2.5-flash"; 
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
// 🪄 MAGIC SUGGEST (Gemini Implementation)
// ==========================================
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API Key missing." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "Endpoints required." });

    console.log(`[Magic] Analyzing ${endpoints.length} endpoints via ${GEMINI_MODEL} (v1)...`);

    try {
        const CHUNK_SIZE = 25;
        const chunks = [];
        for (let i = 0; i < endpoints.length; i += CHUNK_SIZE) {
            chunks.push(endpoints.slice(i, i + CHUNK_SIZE));
        }

        let allSuggestions: string[] = [];

        for (const [index, chunk] of chunks.entries()) {
            const schemaSummary = chunk.map((e: any) => `- ID: "${e.id}" | Description: ${e.description}`).join('\n');
            
            const userPrompt = `You are an AI Tool Architect. Suggest the 3-5 most useful endpoints from the provided list for an AI agent.
CRITICAL: Return ONLY a valid JSON object with a "suggestions" array. Do not include markdown formatting or backticks.
Format: {"suggestions": ["METHOD:PATH"]}

Endpoints to analyze:
${schemaSummary}`;

            const url = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
            
            const result = await axios.post(url, {
                contents: [{ parts: [{ text: userPrompt }] }],
                generationConfig: { 
                    temperature: 0.1 
                }
            });

            const aiRaw = result.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            
            if (aiRaw) {
                // Strip markdown code blocks in case the AI includes them anyway
                const cleanJson = aiRaw.replace(/```json/g, "").replace(/```/g, "").trim();
                try {
                    const parsed = JSON.parse(cleanJson);
                    const batchSuggestions = (parsed.suggestions || []).map((s: string) => s.trim());
                    allSuggestions = [...allSuggestions, ...batchSuggestions];
                } catch (pErr) {
                    console.error("AI returned malformed JSON:", aiRaw);
                }
            }

            if (chunks.length > 1 && index < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
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
// 🚀 DEPLOYMENT & SSE (Preserved)
// ==========================================
app.post('/api/deploy', async (req, res) => {
    try {
        const { endpoints, baseUrl, piiMasking } = req.body;
        const serverId = uuidv4();
        const config = { endpoints, baseUrl: baseUrl.trim(), piiMasking: !!piiMasking, createdAt: new Date().toISOString() };
        if (db) await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
        const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
    } catch (err: any) { res.status(500).json({ error: "Deploy Error", details: err.message }); }
});

const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    if (!db) return res.status(500).send("DB Error");
    const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
    if (!doc.exists) return res.status(404).send("Not found.");
    const vaultData = doc.data();

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);
    const mcpServer = new Server({ name: "MCP-Studio", version: "1.5.2" }, { capabilities: { tools: {} } });
    
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
        const resp = await axios({ method: ep.method, url: `${vaultData.baseUrl}${ep.path}` });
        return { content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }] };
    });

    await mcpServer.connect(transport);
});

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (transport) await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MCP Proxy Live (v1.5.2) with ${GEMINI_MODEL}`));