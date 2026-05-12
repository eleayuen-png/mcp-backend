import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import Stripe from 'stripe';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = express();
app.use(cors());

// ==========================================
// 🚀 1. INITIALIZATION
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = new Stripe(stripeKey || 'sk_test_dummy', { apiVersion: '2026-04-22.dahlia' });

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase Admin Initialized.");
    }
} catch (e) { 
    console.error("❌ Firebase Admin failed to initialize."); 
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

// ==========================================
// 💳 2. STRIPE WEBHOOK
// ==========================================
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!sig || !webhookSecret) return res.status(400).send("Missing config");

    try {
        const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object as any;
            const userId = session.client_reference_id; 
            if (userId && db) {
                const userDocRef = db.collection('artifacts').doc('mcp-studio-v1').collection('users').doc(userId).collection('project').doc('current');
                await userDocRef.set({ isPro: true }, { merge: true });
                console.log(`✅ Upgraded user ${userId} to Pro!`);
            }
        }
    } catch (err: any) { 
        console.error("❌ Webhook error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`); 
    }
    res.send();
});

// IMPORTANT: We move express.json() AFTER the SSE message route or handle it specifically
app.use(express.json());

// ==========================================
// ✨ 3. MAGIC SUGGEST
// ==========================================
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "API Key missing" });
    if (!endpoints) return res.status(400).json({ error: "No endpoints" });

    try {
        const schemaSummary = endpoints.map((e:any) => `- ID: ${e.id}\n  Desc: ${e.description}`).join('\n');
        const systemPrompt = `Analyze the API list and suggest the top 5-10 most 'agentic' ones. Return ONLY JSON with a "suggestions" key.`;
        const userPrompt = `Suggest tools:\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: "application/json" }
        });
        
        const text = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
        res.json(JSON.parse(text));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 🛡️ PII MASKING & 📂 VAULT
// ==========================================
const deploymentVault = new Map<string, any>();
const activeTransports = new Map<string, SSEServerTransport>();

app.post('/api/deploy', (req, res) => {
    const { apiKey, endpoints, baseUrl, macros, piiMasking } = req.body;
    const serverId = uuidv4();
    deploymentVault.set(serverId, { apiKey, endpoints: endpoints || [], baseUrl, macros: macros || [], piiMasking: !!piiMasking });
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({ success: true, serverId, sseUrl: `${publicUrl}/sse/${serverId}` });
});

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = deploymentVault.get(serverId);
    if (!vaultData) return res.status(404).send("Config not found.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.0" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: any[] = [];
        vaultData.endpoints.forEach((ep: any) => {
            const toolName = `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            tools.push({
                name: toolName,
                description: ep.description || `Execute ${ep.method} on ${ep.path}`,
                inputSchema: { 
                    type: "object", 
                    properties: { 
                        params: { type: "object", description: "URL Query parameters" }, 
                        body: { type: "object", description: "JSON Request body" } 
                    } 
                }
            });
        });
        vaultData.macros.forEach((m: any) => {
            tools.push({ name: m.name.replace(/\s+/g, '_').toLowerCase(), description: m.description, inputSchema: { type: "object", properties: {} } });
        });
        return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        
        // Find if it's a standard endpoint
        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        
        if (endpoint) {
            const isGet = endpoint.method.toUpperCase() === 'GET';
            try {
                const response = await axios({ 
                    method: endpoint.method, 
                    url: `${vaultData.baseUrl}${endpoint.path}`, 
                    params: args?.params, 
                    // 🚩 FIX: Only send data/body if it's not a GET request to avoid 415 errors
                    data: isGet ? undefined : (args?.body || {}), 
                    headers: { 
                        'Authorization': `Bearer ${vaultData.apiKey}`,
                        // 🚩 FIX: Only set Content-Type for requests with bodies
                        ...(isGet ? {} : { 'Content-Type': 'application/json' })
                    } 
                });
                return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
            } catch (err: any) {
                return { 
                    content: [{ type: "text", text: `API Error (${err.response?.status}): ${JSON.stringify(err.response?.data || err.message)}` }],
                    isError: true 
                };
            }
        }
        throw new Error(`Tool ${toolName} not recognized.`);
    });

    await mcpServer.connect(transport);
});

// 🚩 FIX: The "stream not readable" error
// We must handle the POST from Cursor carefully. 
// If express.json() is already active, we pass the body manually if the transport supports it,
// or we ensure the transport can read the already-parsed JSON.
app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Transport expired.");

    try {
        // The SSEServerTransport expects to handle the request. 
        // If it fails with "stream not readable", it's because express.json() consumed the body.
        await transport.handlePostMessage(req, res);
    } catch (e: any) {
        console.error("SSE Post Error:", e.message);
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy Backend Live on port ${PORT}`));