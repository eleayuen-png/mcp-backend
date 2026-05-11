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
// 🚀 1. INITIALIZATION (Stripe & Firebase)
// ==========================================

// Initialize Stripe using your secret key from environment variables
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2026-04-22.dahlia', // Matching the installed SDK types
});

// Initialize Firebase Admin so the backend can write to Firestore securely
let db: FirebaseFirestore.Firestore | null = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(serviceAccount) });
        db = getFirestore();
        console.log("🔥 Firebase Admin Initialized successfully.");
    } else {
        console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT env var is missing. Firestore updates disabled.");
    }
} catch (e) {
    console.error("❌ Firebase Admin initialization failed:", e);
}

// ==========================================
// 💳 2. STRIPE WEBHOOK (Must be before express.json!)
// ==========================================
// Stripe requires the raw, unparsed body to verify the cryptographic signature.
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
        console.error("❌ Missing Stripe signature or Webhook Secret.");
        res.status(400).send(`Webhook Error: Missing configuration.`);
        return;
    }

    let event;

    try {
        // Verify this request actually came from Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
        console.error(`❌ Webhook signature verification failed:`, err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    // Handle the successful payment event
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        
        // This is the user ID we passed in from UpgradeModal.tsx!
        const userId = session.client_reference_id; 

        if (userId && db) {
            try {
                // Update the user's document in Firestore to unlock Pro features
                const userDocRef = db.collection('artifacts')
                                     .doc('mcp-studio-v1')
                                     .collection('users')
                                     .doc(userId)
                                     .collection('project')
                                     .doc('current');
                                     
                await userDocRef.set({ isPro: true }, { merge: true });
                console.log(`✅ Successfully upgraded user ${userId} to Pro!`);
            } catch (err) {
                console.error(`❌ Failed to update Firestore for user ${userId}:`, err);
            }
        } else {
            console.warn("⚠️ Checkout completed, but no User ID found or DB not connected.");
        }
    }

    // Always return a 200 to tell Stripe we received the ping
    res.send();
});

// Now we can apply standard JSON parsing for the rest of the MCP endpoints
app.use(express.json());

// ==========================================
// 🛡️ PII MASKING UTILITY
// ==========================================
const maskSensitiveData = (data: any): any => {
    if (!data) return data;
    let jsonString = JSON.stringify(data);
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const phoneRegex = /(\+\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
    jsonString = jsonString.replace(emailRegex, "[REDACTED_EMAIL]").replace(phoneRegex, "[REDACTED_PHONE]");
    return JSON.parse(jsonString);
};

// ==========================================
// 📂 THE VAULT (In-Memory Database)
// ==========================================
const deploymentVault = new Map<string, {
    apiKey: string;
    endpoints: any[];
    baseUrl: string;
    macros: any[];
    piiMasking: boolean;
}>();

const activeTransports = new Map<string, SSEServerTransport>();

// ==========================================
// ENDPOINT 3: Deploy (Called by React Frontend)
// ==========================================
app.post('/api/deploy', (req, res) => {
    const { apiKey, endpoints, baseUrl, macros, piiMasking } = req.body;
    const serverId = uuidv4();

    deploymentVault.set(serverId, {
        apiKey: apiKey,
        endpoints: endpoints || [],
        baseUrl: baseUrl,
        macros: macros || [],
        piiMasking: !!piiMasking
    });

    console.log(`[VAULT] Deployed ${serverId}. PII Masking: ${!!piiMasking}`);

    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

    res.json({
        success: true,
        serverId: serverId,
        sseUrl: `${publicUrl}/sse/${serverId}`, 
    });
});

// ==========================================
// ENDPOINT 4: SSE Connection (Claude/Cursor connects here)
// ==========================================
app.get('/sse/:serverId', async (req, res) => {
    const serverId = req.params.serverId;
    const vaultData = deploymentVault.get(serverId);
    
    if (!vaultData) {
        res.status(404).send("Configuration not found. Please re-deploy from MCP Studio.");
        return;
    }

    const transport = new SSEServerTransport("/messages/" + serverId, res);
    activeTransports.set(serverId, transport);

    const mcpServer = new Server({
        name: "MCP-Studio-Managed-Proxy",
        version: "1.1.0"
    }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools: any[] = [];
        
        vaultData.endpoints.forEach(ep => {
            const safeName = `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            tools.push({
                name: safeName,
                description: ep.description || `Execute ${ep.method} on ${ep.path}`,
                inputSchema: { 
                    type: "object", 
                    properties: {
                        params: { type: "object", description: "Query or Path parameters" },
                        body: { type: "object", description: "Request JSON body" }
                    } 
                }
            });
        });

        vaultData.macros.forEach(m => {
            tools.push({
                name: m.name.replace(/\s+/g, '_').toLowerCase(),
                description: m.description,
                inputSchema: { type: "object", properties: {} }
            });
        });

        return { tools };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name.toLowerCase();
        const args = request.params.arguments as any;
        
        const macro = vaultData.macros.find(m => m.name.toLowerCase() === toolName);
        if (macro) {
            console.log(`[EXEC] Running Macro: ${toolName}`);
            let sequenceResults = [];
            
            for (const step of macro.steps) {
                const response = await axios({
                    method: step.method,
                    url: `${vaultData.baseUrl}${step.path}`,
                    headers: { 'Authorization': `Bearer ${vaultData.apiKey}` }
                });
                
                let stepData = response.data;
                if (vaultData.piiMasking) stepData = maskSensitiveData(stepData);
                
                sequenceResults.push({ step: step.path, data: stepData });
            }
            return { content: [{ type: "text", text: JSON.stringify(sequenceResults, null, 2) }] };
        }

        const endpoint = vaultData.endpoints.find(e => {
            const safeName = `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase();
            return safeName === toolName;
        });

        if (endpoint) {
            console.log(`[EXEC] Running Tool: ${toolName}`);
            try {
                const response = await axios({
                    method: endpoint.method,
                    url: `${vaultData.baseUrl}${endpoint.path}`,
                    params: args?.params,
                    data: args?.body,
                    headers: { 
                        'Authorization': `Bearer ${vaultData.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                let finalData = response.data;
                if (vaultData.piiMasking) {
                    finalData = maskSensitiveData(finalData);
                }

                return { content: [{ type: "text", text: JSON.stringify(finalData, null, 2) }] };
            } catch (err: any) {
                return {
                    content: [{ type: "text", text: `API Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}` }],
                    isError: true
                };
            }
        }
        
        throw new Error(`Tool ${toolName} not recognized.`);
    });

    await mcpServer.connect(transport);
});

// ==========================================
// ENDPOINT 5: Message Routing (Claude -> Server)
// ==========================================
app.post('/messages/:serverId', async (req, res) => {
    const transport = activeTransports.get(req.params.serverId);
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(404).send("Transport session expired.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Proxy Backend Live on port ${PORT}`);
    console.log(`🔒 PII Redaction Engine: Initialized`);
});