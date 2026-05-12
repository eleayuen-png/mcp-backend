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
// 🚀 1. INITIALIZATION (Firestore & Gemini)
// ==========================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = "gemini-1.5-flash"; 
const APP_ID = 'mcp-studio-v1';

let db: any = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        if (getApps().length === 0) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            initializeApp({ credential: cert(serviceAccount) });
        }
        db = getFirestore();
        
        // 🚩 CRITICAL FIX for 500 Error: 
        // This tells Firestore to ignore 'undefined' fields instead of crashing the server.
        db.settings({ ignoreUndefinedProperties: true });
        
        console.log("🔥 Firestore v1.2.7 Initialized. Settings: ignoreUndefinedProperties=true");
    }
} catch (e: any) { 
    console.error("❌ Firebase Init Failed:", e.message); 
}

// ==========================================
// 📡 2. MIDDLEWARE & HELPERS
// ==========================================

// Handle JSON but skip for MCP message streams to avoid "Stream not readable"
app.use((req, res, next) => {
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

// Health check to verify version
app.get('/api/health', (req, res) => res.json({ status: "ok", version: "1.2.7", dbConnected: !!db }));

// ==========================================
// 📡 3. PUBLIC API ROUTES
// ==========================================

/**
 * 🪄 MAGIC SUGGEST
 * Fixed 404 and added better AI cleaning
 */
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini Key missing on Render env." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "Endpoints required." });

    try {
        const schemaSummary = endpoints.map((e: any) => `- ID: ${e.id}\n  Desc: ${e.description}`).join('\n');
        const systemPrompt = `Suggest the top 5-10 most 'agentic' tools. Return ONLY JSON: {"suggestions": ["ID1", "ID2"]}`;
        const userPrompt = `Analyze endpoints:\n\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });
        
        const aiText = result.data.candidates?.[0]?.content?.parts?.[0]?.text || '{"suggestions":[]}';
        const cleaned = aiText.replace(/```json|```/g, "").trim();
        res.json(JSON.parse(cleaned));
    } catch (error: any) {
        console.error("AI Analysis Error:", error.message);
        res.status(500).json({ error: "AI failed to respond.", details: error.message });
    }
});

/**
 * 🚀 DEPLOYMENT
 * Fixed 500 error with Firestore settings and fallback checks
 */
app.post('/api/deploy', async (req, res) => {
    try {
        const { apiKey, endpoints, baseUrl, piiMasking } = req.body;

        if (!baseUrl) return res.status(400).json({ error: "Base URL missing." });

        const serverId = uuidv4();
        
        // Define config explicitly
        const config = {
            apiKey: apiKey || 'no-key-provided',
            endpoints: endpoints || [],
            baseUrl: baseUrl.trim(),
            piiMasking: !!piiMasking,
            createdAt: new Date().toISOString()
        };
        
        if (db) {
            // Document creation in persistent vault
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
            console.log(`[Vault] Successfully saved deployment ${serverId}`);
        }

        const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });

    } catch (err: any) {
        console.error("Critical Deploy Error:", err.message);
        res.status(500).json({ error: "Database or Server Error", details: err.message });
    }
});

// ==========================================
// 📡 4. MCP SSE SERVER LOGIC
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    
    if (!vaultData) return res.status(404).send("Deployment not found. Please re-deploy.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.2.7" }, { capabilities: { tools: {} } });

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

// Explicitly handle Cursor's POST probe to force it to use standard SSE
app.post('/sse/:serverId', (req, res) => res.status(405).send("Use GET for SSE"));

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MCP Proxy v1.2.7 Live on port ${PORT}`));