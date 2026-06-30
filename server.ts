import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ==========================================
// 🛡️ 0. CRASH PROTECTION
// ==========================================
// Catch any top-level exceptions so Render logs them instead of silently crashing
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 CRITICAL UNHANDLED REJECTION:', reason);
});

const app = express();

// ==========================================
// 🌐 1. CORS CONFIGURATION (BULLETPROOF)
// ==========================================
app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Always echo back the exact origin that requested it (perfect for GitHub pages)
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Intercept preflight OPTIONS request and return immediately
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    
    next();
});

// ==========================================
// 🕵️ 2. MIDDLEWARE & LOGGING
// ==========================================
app.use((req, res, next) => {
    console.log(`[NETWORK SPY] ${req.method} request to ${req.path}`);
    
    // Skip body parsing for SSE (stream) and Stripe webhook (needs raw bytes for sig verification)
    if (req.path.startsWith('/sse/') || req.path === '/api/stripe/webhook') {
        next();
    } else {
        express.json({ limit: '50mb' })(req, res, next);
    }
});

// ==========================================
// 🏥 3. HEALTH CHECKS
// ==========================================
app.get('/', (req, res) => {
    res.status(200).send('MCP Proxy Backend is running!');
});

app.get('/health', (req, res) => {
    res.status(200).send("🚀 MCP BACKEND IS ALIVE AND THE NEW CODE IS RUNNING!");
});

// ==========================================
// 🔧 4. SERVICES INITIALIZATION
// ==========================================
const stripeKey = process.env.STRIPE_SECRET_KEY;
let stripe: any = null;
try {
    // Failsafe for CommonJS/ESM interop with Stripe class
    const StripeClient = (Stripe as any).default || Stripe;
    stripe = new StripeClient(stripeKey || 'sk_test_dummy', { apiVersion: '2023-10-16' });
} catch (e: any) {
    console.error("❌ Stripe Init Failed:", e.message);
}

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
} catch (e: any) { 
    console.error("❌ Firebase Init Failed:", e.message); 
}

// ==========================================
// 🪄 5. MAGIC SUGGEST (Gemini Implementation)
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
                generationConfig: { temperature: 0.1 }
            });

            const aiRaw = result.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            
            if (aiRaw) {
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
// 🚀 6. DEPLOYMENT & SSE
// ==========================================
app.post('/api/deploy', async (req, res) => {
    try {
        const { endpoints, baseUrl, piiMasking, paginationConfig, credentials } = req.body;
        const serverId = uuidv4();
        const config = {
            endpoints,
            baseUrl: baseUrl.trim(),
            piiMasking: !!piiMasking,
            paginationConfig: paginationConfig || {},
            credentials: credentials || [],
            createdAt: new Date().toISOString(),
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

const activeTransports = new Map<string, any>(); // Using 'any' because SSEServerTransport is dynamically imported

app.get('/sse/:serverId', async (req, res) => {
    try {
        const serverId = req.params.serverId;
        if (!db) return res.status(500).send("DB Error");
        
        const doc = await db.collection('artifacts').doc(APP_ID).collection('public').doc('data').collection('deployments').doc(serverId).get();
        if (!doc.exists) return res.status(404).send("Not found.");
        
        const vaultData = doc.data() || {};
        
        const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
        const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
        const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

        // 🚨 CRITICAL FIX: The transport expects POST messages to match its exact path!
        const transport = new SSEServerTransport("/sse/" + serverId, res);
        
        activeTransports.set(serverId, transport);
        const mcpServer = new Server({ name: "MCP-Studio", version: "1.5.4" }, { capabilities: { tools: {} } });
        
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: (vaultData.endpoints || []).map((ep: any) => ({
                name: `${ep.method}_${ep.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase(),
                description: ep.description || `Call ${ep.method} ${ep.path}`,
                inputSchema: { type: "object", properties: { params: { type: "object" }, body: { type: "object" } } }
            }))
        }));

        mcpServer.setRequestHandler(CallToolRequestSchema, async (req: any) => {
            const toolName = req.params.name.toLowerCase();
            const ep = vaultData.endpoints.find((e: any) => `${e.method}_${e.path.replace(/[^a-zA-Z0-9]/g, '_')}`.toLowerCase() === toolName);
            if (!ep) throw new Error("Tool not found.");

            const args = req.params.arguments || {};
            const queryParams: Record<string, any> = args.params || {};
            const requestBody = args.body || {};
            const epKey = `${ep.method}:${ep.path}`;
            const pagCfg = (vaultData.paginationConfig || {})[epKey];

            // Build auth headers and query params from stored credentials
            const authHeaders: Record<string, string> = {};
            const authQueryParams: Record<string, string> = {};
            for (const cred of (vaultData.credentials || [])) {
                if (!cred.key) continue;
                if (cred.type === 'bearer') {
                    authHeaders['Authorization'] = `Bearer ${cred.key}`;
                } else if (cred.type === 'apiKey-header' || cred.type === 'api-key') {
                    authHeaders[cred.headerName || 'X-API-Key'] = cred.key;
                } else if (cred.type === 'apiKey-query') {
                    authQueryParams[cred.queryParam || 'api_key'] = cred.key;
                } else if (cred.type === 'basic') {
                    authHeaders['Authorization'] = `Basic ${Buffer.from(cred.key).toString('base64')}`;
                }
            }

            const makeRequest = (extraParams: Record<string, any> = {}) => axios({
                method: ep.method,
                url: `${vaultData.baseUrl}${ep.path}`,
                headers: authHeaders,
                params: ep.method === 'GET'
                    ? { ...authQueryParams, ...queryParams, ...extraParams }
                    : Object.keys(authQueryParams).length ? authQueryParams : undefined,
                data: ep.method !== 'GET' ? requestBody : undefined,
            });

            const getNestedValue = (obj: any, path: string): any => {
                if (!path) return obj;
                return path.split('.').reduce((curr: any, key: string) => curr?.[key], obj);
            };

            if (pagCfg?.enabled) {
                let allItems: any[] = [];
                let cursor: string | null = null;
                const MAX_ITEMS = pagCfg.maxItems || 500;

                for (let i = 0; i < 20; i++) {
                    const extraParams: Record<string, any> = {};
                    if (cursor) extraParams[pagCfg.cursorParam] = cursor;

                    const resp = await makeRequest(extraParams);
                    const items = getNestedValue(resp.data, pagCfg.itemsPath);
                    if (Array.isArray(items)) allItems = allItems.concat(items);

                    cursor = getNestedValue(resp.data, pagCfg.cursorPath) ?? null;
                    if (!cursor || allItems.length >= MAX_ITEMS) break;
                }

                const truncated = allItems.length > MAX_ITEMS;
                const result: any = {
                    items: allItems.slice(0, MAX_ITEMS),
                    total_fetched: Math.min(allItems.length, MAX_ITEMS),
                    truncated,
                };
                if (truncated) result.note = `Results truncated at ${MAX_ITEMS} items. Adjust the limit in MCP Studio if needed.`;

                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }

            const resp = await makeRequest();
            return { content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }] };
        });

        await mcpServer.connect(transport);
    } catch (err: any) {
        console.error("SSE Setup Error:", err);
        if (!res.headersSent) res.status(500).send("Internal SSE Error");
    }
});

// 🚨 CRITICAL FIX: Change from /messages/:serverId to /sse/:serverId
app.post('/sse/:serverId', async (req, res) => {
    try {
        const transport = activeTransports.get(req.params.serverId);
        if (transport) {
            await transport.handlePostMessage(req, res);
        } else {
            res.status(404).send("Transport not found");
        }
    } catch (err: any) {
        console.error("Message Error:", err);
        if (!res.headersSent) res.status(500).send("Message Error");
    }
});

// ==========================================
// 📊 7. ANALYTICS (Admin Only)
// ==========================================

const analyticsCache: Record<string, { data: any; fetchedAt: number }> = {};
const CACHE_TTL_MS = 30_000;

async function fetchPostHogEvents(days: number): Promise<any[]> {
    const cacheKey = `events_${days}d`;
    const cached = analyticsCache[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    const personalKey = process.env.POSTHOG_PERSONAL_API_KEY;
    const projectId = process.env.POSTHOG_PROJECT_ID;
    if (!personalKey || !projectId) throw new Error('PostHog env vars not configured');

    const resp = await axios.get(`https://us.posthog.com/api/projects/${projectId}/events/`, {
        params: { date_from: `-${days}d`, limit: 1000 },
        headers: { Authorization: `Bearer ${personalKey}` }
    });

    const events = resp.data.results || [];
    analyticsCache[cacheKey] = { data: events, fetchedAt: Date.now() };
    return events;
}

const adminMiddleware = async (req: any, res: any, next: any) => {
    if (!db) return res.status(503).json({ error: 'Firebase not initialized' });

    const authHeader = req.headers.authorization as string | undefined;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = await getAuth().verifyIdToken(authHeader.slice(7));
        const adminEmails = (process.env.ADMIN_EMAILS || '')
            .split(',')
            .map((e: string) => e.trim().toLowerCase());

        if (!decoded.email || !adminEmails.includes(decoded.email.toLowerCase())) {
            return res.status(403).json({ error: 'Not authorized' });
        }

        req.adminUser = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

app.get('/api/analytics/summary', adminMiddleware, async (req: any, res: any) => {
    try {
        const [e7, e30] = await Promise.all([fetchPostHogEvents(7), fetchPostHogEvents(30)]);
        res.json({
            pageviews_7d: e7.filter((e: any) => e.event === '$pageview').length,
            pageviews_30d: e30.filter((e: any) => e.event === '$pageview').length,
            unique_users_7d: new Set(e7.map((e: any) => e.distinct_id)).size,
            unique_users_30d: new Set(e30.map((e: any) => e.distinct_id)).size,
            deployments_7d: e7.filter((e: any) => e.event === 'server_deployed').length,
            upgrade_clicks_7d: e7.filter((e: any) => e.event === 'pro_upgrade_clicked').length,
        });
    } catch (e: any) {
        console.error('Analytics summary error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/analytics/timeseries', adminMiddleware, async (req: any, res: any) => {
    try {
        const events = await fetchPostHogEvents(7);

        const groups: Record<string, { pageviews: number; deployments: number }> = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            groups[d.toISOString().split('T')[0]] = { pageviews: 0, deployments: 0 };
        }
        events.forEach((e: any) => {
            const date = (e.timestamp || '').split('T')[0];
            if (!groups[date]) return;
            if (e.event === '$pageview') groups[date].pageviews++;
            if (e.event === 'server_deployed') groups[date].deployments++;
        });

        res.json(
            Object.entries(groups)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([date, counts]) => ({ date: date.slice(5), ...counts }))
        );
    } catch (e: any) {
        console.error('Analytics timeseries error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/analytics/live', adminMiddleware, async (req: any, res: any) => {
    try {
        const events = await fetchPostHogEvents(1);
        res.json(
            events.slice(0, 25).map((e: any) => ({
                id: e.uuid,
                event: e.event,
                distinct_id: e.distinct_id,
                timestamp: e.timestamp,
                properties: {
                    url: e.properties?.$current_url || e.properties?.$pathname,
                    browser: e.properties?.$browser,
                    os: e.properties?.$os,
                },
            }))
        );
    } catch (e: any) {
        console.error('Analytics live error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 💳 8. STRIPE WEBHOOK
// ==========================================

const PRICE_INTERVALS: Record<string, string> = {
    'price_1TXKqQG8ojULiiimRWvvLceo': 'monthly',
    'price_1TnE52G8ojULiiimf7H4FO34': 'quarterly',
    'price_1TnEQCG8ojULiiimWzEhRn0o': 'semiannual',
    'price_1TnEpKG8ojULiiim1X4Q9u02': 'annual',
};

async function setUserPro(uid: string, isPro: boolean, extra: Record<string, any> = {}) {
    if (!db) return;
    const ref = db.collection('artifacts').doc(APP_ID)
        .collection('users').doc(uid)
        .collection('project').doc('current');
    await ref.set({ isPro, ...extra }, { merge: true });
}

async function uidFromCustomer(customerId: string): Promise<string | null> {
    if (!db) return null;
    const doc = await db.collection('stripe_customers').doc(customerId).get();
    return doc.exists ? doc.data()?.uid : null;
}

app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), async (req: any, res: any) => {
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret) {
        console.error('❌ STRIPE_WEBHOOK_SECRET not set');
        return res.status(500).send('Webhook secret not configured');
    }
    if (!stripe) return res.status(500).send('Stripe not initialized');

    let event: any;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (e: any) {
        console.error('⚠️ Webhook signature failed:', e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    console.log(`[Stripe] Event: ${event.type}`);

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const uid = session.client_reference_id;
            const customerId = session.customer;
            const subscriptionId = session.subscription;
            if (!uid || !subscriptionId) return res.json({ received: true });

            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            const priceId = sub.items.data[0]?.price?.id;
            const planInterval = PRICE_INTERVALS[priceId] || 'monthly';
            const proExpiresAt = new Date(sub.current_period_end * 1000).toISOString();

            await setUserPro(uid, true, { planInterval, proExpiresAt, stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId });
            if (db) await db.collection('stripe_customers').doc(customerId).set({ uid });

            console.log(`[Stripe] ✅ Pro activated for uid=${uid} plan=${planInterval} expires=${proExpiresAt}`);
        }

        else if (event.type === 'customer.subscription.updated') {
            const sub = event.data.object;
            const uid = await uidFromCustomer(sub.customer);
            if (!uid) return res.json({ received: true });

            const priceId = sub.items.data[0]?.price?.id;
            const planInterval = PRICE_INTERVALS[priceId] || 'monthly';
            const proExpiresAt = new Date(sub.current_period_end * 1000).toISOString();
            const active = sub.status === 'active';

            await setUserPro(uid, active, active
                ? { planInterval, proExpiresAt }
                : { planInterval: null, proExpiresAt: null }
            );
            console.log(`[Stripe] 🔄 Subscription updated uid=${uid} status=${sub.status}`);
        }

        else if (event.type === 'customer.subscription.deleted') {
            const sub = event.data.object;
            const uid = await uidFromCustomer(sub.customer);
            if (!uid) return res.json({ received: true });

            await setUserPro(uid, false, { planInterval: null, proExpiresAt: null });
            console.log(`[Stripe] ❌ Pro cancelled uid=${uid}`);
        }
    } catch (e: any) {
        console.error('[Stripe] Webhook handler error:', e.message);
        return res.status(500).send('Webhook handler failed');
    }

    res.json({ received: true });
});

// ==========================================
// 🏁 9. START SERVER
// ==========================================
try {
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 MCP Proxy Live (v1.5.4) on port ${PORT} with ${GEMINI_MODEL}`);
    });
} catch (startError) {
    console.error("🔥 Failed to bind server port:", startError);
}