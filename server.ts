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

app.use(express.json());

// ==========================================
// ✨ 3. MAGIC SUGGEST: AI SCHEMA ANALYSIS
// ==========================================
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;

    // 🚩 CHECK 1: Missing API Key
    if (!GEMINI_API_KEY) {
        console.error("❌ ERROR: GEMINI_API_KEY is not set in Render environment variables.");
        return res.status(500).json({ 
            error: "Internal Configuration Error", 
            details: "GEMINI_API_KEY is missing on the server. Please add it to Render environment variables." 
        });
    }

    if (!endpoints || !Array.isArray(endpoints)) {
        return res.status(400).json({ error: "No endpoints provided." });
    }

    try {
        console.log(`🧠 Analyzing ${endpoints.length} endpoints...`);
        
        const schemaSummary = endpoints.map(e => `- ID: ${e.id}\n  Desc: ${e.description}`).join('\n');

        const systemPrompt = `You are an expert AI Agent Architect. Analyze the list of API endpoints provided and suggest the top 5-10 most 'agentic' ones. 
        Focus on endpoints that allow searching, creating, updating, or retrieving high-value data. 
        Return ONLY a JSON object with a "suggestions" key containing an array of strings (the endpoint IDs).`;

        const userPrompt = `Suggest the best tools from this list:\n${schemaSummary}`;

        const callGemini = async (retryCount = 0): Promise<any> => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
            try {
                const result = await axios.post(url, {
                    contents: [{ parts: [{ text: userPrompt }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    generationConfig: { 
                        responseMimeType: "application/json"
                    }
                });
                
                const responseText = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!responseText) throw new Error("Empty response from AI");
                
                // Parse and handle both stringified JSON and direct objects
                const parsed = JSON.parse(responseText);
                return parsed.suggestions || [];
            } catch (error: any) {
                if (retryCount < 3 && error.response?.status >= 500) {
                    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, retryCount)));
                    return callGemini(retryCount + 1);
                }
                throw error;
            }
        };

        const suggestions = await callGemini();
        console.log(`✨ AI Suggested: ${suggestions.length} tools.`);
        res.json({ suggestions });

    } catch (error: any) {
        console.error("❌ Magic Suggest Failed:", error.response?.data || error.message);
        
        // 🚩 FALLBACK: If AI fails, suggest common endpoints automatically so the user isn't stuck
        const fallbackSuggestions = endpoints
            .filter(e => e.id.toLowerCase().includes('get') || e.id.toLowerCase().includes('search'))
            .slice(0, 5)
            .map(e => e.id);

        res.status(200).json({ 
            suggestions: fallbackSuggestions,
            warning: "AI Analysis failed, using heuristic fallback.",
            details: error.message 
        });
    }
});

// ==========================================
// 🛡️ PII MASKING & 📂 VAULT
// ==========================================
const maskSensitiveData = (data: any): any => {
    if (!data) return data;
    try {
        let jsonString = JSON.stringify(data);
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const phoneRegex = /(\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
        jsonString = jsonString.replace(emailRegex, "[REDACTED_EMAIL]").replace(phoneRegex, "[REDACTED_PHONE]");
        return JSON.parse(jsonString);
    } catch (e) { return data; }
};

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

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.1.0" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: any[] = [];
        vaultData.endpoints.forEach((ep: any) => {
            const toolName = `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            tools.push({
                name: toolName,
                description: ep.description || `Execute ${ep.method} on ${ep.path}`,
                inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
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
        
        const macro = vaultData.macros.find((m: any) => m.name.toLowerCase() === toolName);
        if (macro) {
            let sequenceResults = [];
            for (const step of macro.steps) {
                const response = await axios({ method: step.method, url: `${vaultData.baseUrl}${step.path}`, headers: { 'Authorization': `Bearer ${vaultData.apiKey}` } });
                let stepData = response.data;
                if (vaultData.piiMasking) stepData = maskSensitiveData(stepData);
                sequenceResults.push({ step: step.path, data: stepData });
            }
            return { content: [{ type: "text", text: JSON.stringify(sequenceResults, null, 2) }] };
        }

        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        if (endpoint) {
            const response = await axios({ method: endpoint.method, url: `${vaultData.baseUrl}${endpoint.path}`, params: args?.params, data: args?.body, headers: { 'Authorization': `Bearer ${vaultData.apiKey}`, 'Content-Type': 'application/json' } });
            let finalData = response.data;
            if (vaultData.piiMasking) finalData = maskSensitiveData(finalData);
            return { content: [{ type: "text", text: JSON.stringify(finalData, null, 2) }] };
        }
        throw new Error(`Tool ${toolName} not recognized.`);
    });

    await mcpServer.connect(transport);
});

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(404).send("Transport expired.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy Backend Live on port ${PORT}`));