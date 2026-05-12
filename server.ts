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
// 🚀 1. INITIALIZATION (Firestore & Gemini)
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
// @ts-ignore
const stripe = new Stripe(stripeKey || 'sk_test_dummy', { apiVersion: '2023-10-16' });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
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
        console.log("🔥 Firestore v1.3.4 Ready.");
    }
} catch (e: any) { 
    console.error("❌ Firebase Init Failed:", e.message); 
}

// ==========================================
// 📡 2. MIDDLEWARE & HELPERS
// ==========================================
app.use((req, res, next) => {
    if (req.method === 'POST') console.log(`[REQ] ${req.path}`);
    
    if (req.path.startsWith('/messages/') || req.path === '/api/webhook/stripe') {
        next(); 
    } else {
        express.json()(req, res, next);
    }
});

async function getDeployment(serverId: string) {
    if (!db) return null;
    try {
        const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
        return doc.exists ? doc.data() : null;
    } catch (e) { return null; }
}

app.get('/api/health', (req, res) => res.json({ status: "ok", version: "1.3.4", dbConnected: !!db }));

// ==========================================
// 💳 3. STRIPE WEBHOOK
// ==========================================
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!sig || !webhookSecret) return res.status(400).send("Missing Stripe config");

    try {
        const event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret);
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object as any;
            const userId = session.client_reference_id; 
            if (userId && db) {
                const userDocRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('project').doc('current');
                await userDocRef.set({ isPro: true }, { merge: true });
                console.log(`✅ Webhook Success: User ${userId} upgraded to Pro.`);
            }
        }
    } catch (err: any) { 
        console.error("Webhook Error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`); 
    }
    res.send();
});

// ==========================================
// 📡 4. PUBLIC API ROUTES
// ==========================================

/**
 * 🪄 MAGIC SUGGEST
 */
app.post('/api/analyze-schema', async (req, res) => {
    console.log("========== MAGIC SUGGEST TRIGGERED ==========");
    const { endpoints } = req.body;
    
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini Key missing." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "Endpoints required." });

    console.log(`[Diagnostic] Received ${endpoints.length} endpoints from frontend.`);
    if (endpoints.length > 0) {
        console.log(`[Diagnostic] Sample endpoint ID format: "${endpoints[0].id}"`);
    }

    try {
        const schemaSummary = endpoints.slice(0, 100).map((e: any) => `- ID: "${e.id}" | Description: ${e.description}`).join('\n');
        
        const systemPrompt = `You are an AI Tool Architect. Suggest the most useful API endpoints.
        CRITICAL: You must return valid JSON. 
        CRITICAL: The IDs you suggest MUST EXACTLY match the IDs in the provided list.
        Include the exact Method and Path as they appear in the ID string.
        Format: {"suggestions": ["METHOD:PATH", "METHOD:PATH"]}`;

        const userPrompt = `Choose the 5-10 best tools from this list. Return ONLY the IDs:\n\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        }, { timeout: 15000 });
        
        const aiRaw = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
        console.log(`[Diagnostic] RAW AI Response:\n`, aiRaw);

        if (!aiRaw) {
             console.log("[Diagnostic] AI returned no content.");
             return res.json({ suggestions: [], error: "AI returned no content" });
        }

        let suggestions: string[] = [];
        try {
            const parsed = JSON.parse(aiRaw);
            suggestions = (parsed.suggestions || []).map((s: string) => s.replace(/"/g, '').trim());
        } catch (innerParseErr) {
            console.log("[Diagnostic] Standard JSON parse failed, trying regex match...");
            const jsonMatch = aiRaw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                suggestions = (parsed.suggestions || []).map((s: string) => s.replace(/"/g, '').trim());
            } else {
                console.log("[Diagnostic] Regex match failed to find JSON.");
                throw new Error("Could not parse AI response as JSON");
            }
        }

        console.log(`[Diagnostic] Extracted Suggestions Array:`, suggestions);

        const validIds = endpoints.map((e: any) => e.id);
        const matched = suggestions.filter((s: string) => validIds.includes(s));
        const unmatched = suggestions.filter((s: string) => !validIds.includes(s));

        console.log(`[Diagnostic] Valid Matches: ${matched.length}, Hallucinations: ${unmatched.length}`);
        if (unmatched.length > 0) {
            console.warn(`[Diagnostic] Unmatched IDs from AI:`, unmatched);
        }

        console.log("=============================================");
        res.json({ suggestions, matched, unmatched });

    } catch (error: any) {
        const realErrorReason = error.response?.data?.error?.message || error.message || "Unknown AI Error";
        console.error("[Diagnostic] Magic Suggest Error:", realErrorReason);
        res.status(500).json({ suggestions: [], error: `Gemini API Error: ${realErrorReason}` });
    }
});

/**
 * 🚀 DEPLOYMENT
 */
app.post('/api/deploy', async (req, res) => {
    try {
        const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
        if (!baseUrl) return res.status(400).json({ error: "Base URL missing." });

        const serverId = uuidv4();
        const config = {
            apiKey: apiKey || 'no-key-provided',
            endpoints: endpoints || [],
            baseUrl: baseUrl.trim(),
            piiMasking: !!piiMasking,
            createdAt: new Date().toISOString()
        };
        
        if (db) {
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
            console.log(`[Vault] Deployed server config for: ${serverId}`);
        }

        const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
    } catch (err: any) {
        console.error("Deploy Error:", err.message);
        res.status(500).json({ error: "Deploy Error", details: err.message });
    }
});

// ==========================================
// 📡 5. MCP SSE SERVER LOGIC
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    
    if (!vaultData) return res.status(404).send("Deployment not found. Please re-deploy from MCP Studio.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.3.4" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (vaultData.endpoints || []).map((ep: any) => ({
            name: `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase(),
            description: ep.description || `Call ${ep.method} ${ep.path}`,
            inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
        }))
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        
        if (!endpoint) throw new Error(`Tool not recognized.`);

        const isGet = endpoint.method.toUpperCase() === 'GET';
        const response = await axios({ 
            method: endpoint.method, 
            url: `${vaultData.baseUrl}${endpoint.path}`, 
            params: args?.params, 
            data: isGet ? undefined : (args?.body || {}), 
            headers: { 
                'Authorization': `Bearer ${vaultData.apiKey}`,
                ...(isGet ? {} : { 'Content-Type': 'application/json' })
            } 
        });
        return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
    });

    await mcpServer.connect(transport);
});

app.post('/sse/:serverId', (req, res) => res.status(200).json({ status: "Use GET for SSE" }));

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MCP Proxy v1.3.4 Live on port ${PORT}`));