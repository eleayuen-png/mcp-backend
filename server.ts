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
        db.settings({ ignoreUndefinedProperties: true });
        console.log("🔥 Firestore v1.3.0 Ready.");
    }
} catch (e: any) { 
    console.error("❌ Firebase Init Failed:", e.message); 
}

// ==========================================
// 📡 2. MIDDLEWARE
// ==========================================

app.use((req, res, next) => {
    // Log incoming requests for debugging
    if (req.method === 'POST') console.log(`[REQ] ${req.path}`);
    
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
 * 🪄 MAGIC SUGGEST (v1.3.0)
 * Fixed the ID mismatch and parsing issues.
 */
app.post('/api/analyze-schema', async (req, res) => {
    const { endpoints } = req.body;
    
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Gemini Key missing." });
    if (!endpoints || !Array.isArray(endpoints)) return res.status(400).json({ error: "Invalid endpoints." });

    try {
        // We only send the first 100 to stay within token/time limits
        const schemaSummary = endpoints.slice(0, 100).map((e: any) => `ID: "${e.id}" | Desc: ${e.description}`).join('\n');
        
        const systemPrompt = `You are an API Expert. Suggest 5-10 most useful endpoints for an AI assistant.
        CRITICAL: Your response must be valid JSON. 
        CRITICAL: The IDs in your list MUST EXACTLY MATCH the IDs provided (case-sensitive, no extra spaces).
        Format: {"suggestions": ["METHOD:PATH", "METHOD:PATH"]}`;

        const userPrompt = `List of endpoints:\n${schemaSummary}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
        
        const result = await axios.post(url, {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] },
            generationConfig: { 
                responseMimeType: "application/json", 
                temperature: 0.1 
            }
        }, { timeout: 15000 });
        
        const aiRaw = result.data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!aiRaw) {
            return res.json({ suggestions: [], error: "AI returned no content" });
        }

        // Parse the AI response. Since we use responseMimeType: "application/json", 
        // the AI response is usually a clean JSON string.
        try {
            const parsed = JSON.parse(aiRaw);
            console.log(`[AI] Successfully suggested ${parsed.suggestions?.length || 0} tools.`);
            res.json(parsed);
        } catch (innerParseErr) {
            // Fallback for older models or unexpected chatter
            const jsonMatch = aiRaw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                res.json(JSON.parse(jsonMatch[0]));
            } else {
                throw new Error("Could not parse AI response as JSON");
            }
        }

    } catch (error: any) {
        console.error("Magic Suggest Error:", error.message);
        res.json({ suggestions: [], error: "AI analysis timed out or failed." });
    }
});

/**
 * 🚀 DEPLOYMENT
 */
app.post('/api/deploy', async (req, res) => {
    try {
        const { apiKey, endpoints, baseUrl, piiMasking } = req.body;
        const serverId = uuidv4();
        const config = {
            apiKey: apiKey || 'no-key',
            endpoints: endpoints || [],
            baseUrl: baseUrl?.trim() || '',
            piiMasking: !!piiMasking,
            createdAt: new Date().toISOString()
        };
        
        if (db) {
            await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).set(config);
        }

        const publicUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
        res.json({ success: true, sseUrl: `${publicUrl}/sse/${serverId}` });
    } catch (err: any) {
        res.status(500).json({ error: "Deploy Error", details: err.message });
    }
});

// ==========================================
// 📡 4. MCP SSE SERVER LOGIC
// ==========================================
const activeTransports = new Map<string, SSEServerTransport>();

app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = await getDeployment(serverId);
    if (!vaultData) return res.status(404).send("Deployment not found.");

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({ name: "MCP-Studio-Proxy", version: "1.3.0" }, { capabilities: { tools: {} } });

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

app.post('/sse/:serverId', (req, res) => res.status(200).json({ status: "ready" }));

app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (!transport) return res.status(404).send("Session expired.");
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MCP Proxy v1.3.0 Live on port ${PORT}`));