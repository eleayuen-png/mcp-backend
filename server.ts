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
// 🚀 1. INITIALIZATION (Firestore Vault)
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = new Stripe(stripeKey || 'sk_test_dummy', { apiVersion: '2026-04-22.dahlia' });

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT && getApps().length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase Admin Initialized (Persistent Vault Active)");
    }
} catch (e) { 
    console.error("❌ Firebase Admin failed to initialize."); 
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const APP_ID = 'mcp-studio-v1';

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
                const userDocRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('project').doc('current');
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

// ==========================================
// 🛡️ PERSISTENT VAULT HELPERS
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

/**
 * Saves deployment config to Firestore so it survives server restarts.
 */
async function saveDeployment(serverId: string, data: any) {
    if (!db) return;
    try {
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(data);
    } catch (e) {
        console.error("Vault Save Error:", e);
    }
}

/**
 * Retrieves deployment config from Firestore.
 */
async function getDeployment(serverId: string) {
    if (!db) return null;
    try {
        const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
        return doc.exists ? doc.data() : null;
    } catch (e) {
        console.error("Vault Load Error:", e);
        return null;
    }
}

// ==========================================
// 📡 3. DEPLOY & SSE ROUTES
// ==========================================

// Global JSON middleware - we'll be careful with this
app.use(express.json());

app.post('/api/deploy', async (req, res) => {
    const { apiKey, endpoints, baseUrl, macros, piiMasking } = req.body;
    const serverId = uuidv4();
    
    const config = { apiKey, endpoints: endpoints || [], baseUrl, macros: macros || [], piiMasking: !!piiMasking, createdAt: new Date().toISOString() };
    
    // Save to persistent storage
    await saveDeployment(serverId, config);

    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({ success: true, serverId, sseUrl: `${publicUrl}/sse/${serverId}` });
});

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    
    // 🚩 FIX 404: Load from Firestore instead of memory Map
    const vaultData = await getDeployment(serverId);
    if (!vaultData) {
        console.warn(`[SSE] 404 - Config not found for ${serverId}`);
        return res.status(404).send("Config not found. Please redeploy from MCP Studio.");
    }

    console.log(`[SSE] Client connecting to server: ${serverId}`);

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.1" }, { capabilities: { tools: {} } });

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
        return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        
        if (endpoint) {
            const isGet = endpoint.method.toUpperCase() === 'GET';
            try {
                const response = await axios({ 
                    method: endpoint.method, 
                    url: `${vaultData.baseUrl}${endpoint.path}`, 
                    params: args?.params, 
                    data: isGet ? undefined : (args?.body || {}), 
                    headers: { 
                        'Authorization': `Bearer ${vaultData.apiKey}`,
                        ...(isGet ? {} : { 'Content-Type': 'application/json' }) // 🚩 FIX 415: No JSON header on GET
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

// 🚩 FIX: Support Cursor's "Streamable HTTP" POST attempts by redirecting or handling
app.post('/sse/:serverId', (req, res) => {
    res.status(405).send("Please use GET for SSE connection. Cursor should fallback to SSE automatically.");
});

// 🚩 FIX: The "stream not readable" error
app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Transport session expired. Please refresh Cursor.");

    try {
        // We ensure we handle the message even if express.json() already parsed the body
        // The SDK's handlePostMessage is compatible with req.body if already parsed
        await transport.handlePostMessage(req, res);
    } catch (e: any) {
        console.error("SSE Post Error:", e.message);
        res.status(500).send(e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy Backend Live on port ${PORT}`));