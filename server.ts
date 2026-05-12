import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const app = express();
app.use(cors());

// ==========================================
// 🚀 1. INITIALIZATION
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = "gemini-1.5-flash"; // Switched to a more common stable model string
const APP_ID = 'mcp-studio-v1';

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT && getApps().length === 0) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase Admin Initialized.");
    }
} catch (e: any) { 
    console.error("❌ Firebase Init Failed:", e.message); 
}

// ==========================================
// 📡 2. MIDDLEWARE (The Stream Protector)
// ==========================================
app.use((req, res, next) => {
    // We skip JSON parsing for /messages/ because it breaks the SSE stream
    if (req.path.startsWith('/messages/')) {
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

// ==========================================
// 📡 3. PUBLIC API ROUTES
// ==========================================

/**
 * 🪄 MAGIC SUGGEST
 * Improved with AI response cleaning logic.
 */
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "API Key missing" });
    
    try {
        const schemaSummary = endpoints.map((e: any) => `- ID: ${e.id}\n  Desc: ${e.description}`).join('\n');
        const systemPrompt = `Analyze the API list and suggest the top 5-10 most 'agentic' ones. Return ONLY a JSON object with a "suggestions" key containing an array of IDs. No markdown, no chatter.`;
        const userPrompt = `Suggest tools:\n\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });
        
        let aiText = result.data.candidates?.[0]?.content?.parts?.[0]?.text || '{"suggestions":[]}';
        
        // 🚩 FIX: Clean AI "Chatter" (remove markdown code blocks if they exist)
        const cleanedJson = aiText.replace(/```json|```/g, "").trim();
        
        res.json(JSON.parse(cleanedJson));
    } catch (error: any) {
        console.error("AI Error Details:", error.response?.data || error.message);
        res.status(500).json({ error: "AI Analysis failed.", details: error.message });
    }
});

app.post('/api/deploy', async (req, res) => {
    const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
    const serverId = uuidv4();
    const config = { apiKey, endpoints, baseUrl, piiMasking: !!piiMasking, createdAt: new Date().toISOString() };
    
    if (db) {
        await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
    }

    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
});

// ==========================================
// 📡 4. MCP SSE SERVER LOGIC
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    if (!vaultData) return res.status(404).send("Config not found.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.5" }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (vaultData.endpoints || []).map((ep: any) => ({
            name: `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase(),
            description: ep.description || `Execute ${ep.method} on ${ep.path}`,
            inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
        }))
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        const endpoint = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
        
        if (!endpoint) throw new Error(`Tool ${toolName} not found.`);

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

/**
 * 🚩 FIX: CURSOR HANDSHAKE
 * We respond with a 405 (Method Not Allowed) to Cursor's POST probe.
 * This tells Cursor: "I don't support high-speed POST mode, please use standard GET SSE."
 */
app.post('/sse/:serverId', (req, res) => {
    res.status(405).send("Use GET for SSE");
});

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Proxy Live on port ${PORT}`));