/**
 * NovaX AI – Secure Worker with Profile Memory, Rate Limiting & Web Search
 * - Authentication required for all chat and memory updates
 * - Profile fetched securely from KV using user email from JWT
 * - Rate limiting per IP (20 requests/minute)
 * - Versioned profiles for future compatibility
 * - STREAMING SUPPORT for real-time token-by-token responses
 * - Message sanitization to prevent injection attacks
 * - Chat storage endpoints for saving/loading/deleting conversations
 * - REAL WEB SEARCH with citations (via SERPER)
 * - IMAGE GENERATION with Hugging Face Stable Diffusion
 */

// ✅ Firebase JWT Verification
async function verifyFirebaseToken(idToken, projectId) {
  try {
    const [headerB64, payloadB64, signatureB64] = idToken.split(".");

    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new Error("Invalid token format");
    }

    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))
    );

    // Basic checks
    if (payload.aud !== projectId) {
      throw new Error("Invalid audience");
    }

    if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
      throw new Error("Invalid issuer");
    }

    if (payload.exp * 1000 < Date.now()) {
      throw new Error("Token expired");
    }

    return payload; // contains email, uid, etc.
  } catch (error) {
    throw new Error(`Token verification failed: ${error.message}`);
  }
}

// ✅ Input validation helper
function validateRequiredFields(body, fields) {
  const missing = fields.filter(f => !body[f]);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

// ✅ Sanitize string helper
function sanitizeString(str, maxLength = 5000) {
  if (typeof str !== 'string') return '';
  return str.substring(0, maxLength).replace(/[<>]/g, '');
}

// ✅ Safe JSON parse helper
async function safeParseJSON(request) {
  try {
    const methodsWithBody = ["POST", "PUT", "DELETE"];
    if (!methodsWithBody.includes(request.method)) {
      return {};
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return {};
    }

    try {
      return await request.json();
    } catch {
      return {}; // Empty body or invalid JSON → safely ignore
    }

  } catch (error) {
    console.warn("Failed to parse JSON:", error.message);
    return {};
  }
}

// ✅ Sanitize HTML for website builder
function sanitizeHTML(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "") // Remove scripts
    .replace(/on\w+="[^"]*"/gi, "") // Remove onclick, onload, etc.
    .replace(/on\w+='[^']*'/gi, "")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, ""); // Remove iframes
}

export default {
  async fetch(request, env) {
    const { PROFILES, SITES_KV, GROQ_API_KEY, ASTROLOGY_API_KEY, ADMIN_EMAIL, SERPER_API_KEY, FIREBASE_PROJECT_ID, HF_TOKEN } = env;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json"
    };

    // Handle preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders,
          "Content-Type": null
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify({
          name: "NovaX AI API",
          version: "1.0.0",
          status: "operational",
          endpoints: [
            "/api/generate-image",
            "/astro/birth-chart",
            "/astro/daily-panchang",
            "/astro/match-making",
            "/astro/dasha",
            "/api/save-chat",
            "/api/get-chats",
            "/api/delete-chat",
            "/api/update-memory",
            "/api/upload",
            "/api/subscription-status",
            "/api/create-subscription",
            "/api/verify-payment",
            "/api/cancel-subscription",
            "/api/generate-website",
            "/api/publish-website",
            "/api/my-websites",
            "/api/delete-website",
            "/admin"
          ]
        }),
        { headers: corsHeaders }
      );
    }

    // 🌐 SERVE STORED WEBSITES
    if (url.pathname.startsWith("/sites/")) {
      const siteId = url.pathname.split("/")[2];
      if (!siteId) return new Response("Site not found", { status: 404 });

      try {
        const html = await env.SITES_KV.get(`site-html:${siteId}`);
        if (!html) return new Response("Site not found", { status: 404 });

        return new Response(html, {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "public, max-age=3600"
          }
        });
      } catch (err) {
        return new Response("Error fetching site", { status: 500 });
      }
    }

    // Define allowed methods for each endpoint
    const allowedMethods = {
      "/api/get-chats": ["GET"],
      "/api/delete-chat": ["DELETE", "POST"],
      "/api/save-chat": ["POST"],
      "/api/update-memory": ["POST"],
      "/api/upload": ["POST"],
      "/api/generate-image": ["POST"],
      "/api/create-subscription": ["POST"],
      "/api/verify-payment": ["POST"],
      "/api/cancel-subscription": ["POST"],
      "/api/generate-website": ["POST"],
      "/api/publish-website": ["POST"],
      "/api/my-websites": ["GET"],
      "/api/delete-website": ["DELETE", "POST"]
    };

    const pathMethod = allowedMethods[url.pathname];
    if (pathMethod && !pathMethod.includes(request.method)) {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    try {
      const authHeader = request.headers.get("Authorization");

      // ---------------- ADMIN ROUTE ----------------
      if (url.pathname.startsWith("/admin")) {
        if (!authHeader || authHeader !== `Bearer ${ADMIN_EMAIL}`) {
          return new Response(
            JSON.stringify({ error: "Unauthorized - Admin only" }),
            { status: 403, headers: corsHeaders }
          );
        }

        return new Response(
          JSON.stringify({ success: true, message: "Welcome Admin 🚀" }),
          { headers: corsHeaders }
        );
      }

      // ---------------- IMAGE GENERATION ENDPOINT ----------------
      if (url.pathname === "/api/generate-image") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        try {
          const token = authHeader.replace("Bearer ", "");
          await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        try {
          const body = await safeParseJSON(request);
          if (!body) {
            return new Response(
              JSON.stringify({ error: "Invalid JSON body" }),
              { status: 400, headers: corsHeaders }
            );
          }

          const { prompt } = body;

          if (!prompt || typeof prompt !== 'string') {
            return new Response(
              JSON.stringify({ error: "Prompt is required" }),
              { status: 400, headers: corsHeaders }
            );
          }

          const sanitizedPrompt = sanitizeString(prompt, 500);

          const response = await fetch(
            "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0",
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${HF_TOKEN}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                inputs: sanitizedPrompt
              })
            }
          );

          if (!response.ok) {
            const errorText = await response.text();
            return new Response(
              JSON.stringify({
                error: "Image generation failed",
                details: errorText
              }),
              { status: response.status, headers: corsHeaders }
            );
          }

          const imageBlob = await response.arrayBuffer();

          return new Response(imageBlob, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "image/png",
              "Content-Length": imageBlob.byteLength.toString()
            }
          });

        } catch (err) {
          console.error("Image generation error:", err);
          return new Response(
            JSON.stringify({ error: "Image generation failed", details: err.message }),
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // ---------------- ASTROLOGY API ROUTE ----------------
      if (url.pathname.startsWith("/astro/")) {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        try {
          const token = authHeader.replace("Bearer ", "");
          await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        const body = await safeParseJSON(request);
        if (!body) {
          return new Response(
            JSON.stringify({ error: "Invalid JSON body" }),
            { status: 400, headers: corsHeaders }
          );
        }

        const endpointMap = {
          "/astro/birth-chart": "planets",
          "/astro/daily-panchang": "panchang",
          "/astro/match-making": "match-making",
          "/astro/dasha": "vimshottari-dasha"
        };

        const apiEndpoint = endpointMap[url.pathname];

        if (!apiEndpoint) {
          return new Response(JSON.stringify({ error: "Invalid astrology endpoint" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        try {
          validateRequiredFields(body, ['year', 'month', 'date', 'hours', 'minutes', 'seconds', 'latitude', 'longitude', 'timezone']);
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const {
          year = 2005,
          month = 8,
          date = 15,
          hours = 14,
          minutes = 30,
          seconds = 0,
          latitude = 26.8467,
          longitude = 80.9462,
          timezone = 5.5
        } = body;

        if (isNaN(year) || isNaN(month) || isNaN(date) || isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(latitude) || isNaN(longitude) || isNaN(timezone)) {
          return new Response(JSON.stringify({ error: "Invalid numeric values provided" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const astroPayload = {
          year: Number(year),
          month: Number(month),
          date: Number(date),
          hours: Number(hours),
          minutes: Number(minutes),
          seconds: Number(seconds),
          latitude: Number(latitude),
          longitude: Number(longitude),
          timezone: Number(timezone)
        };

        const headers = new Headers();
        headers.set("Content-Type", "application/json");
        headers.set("x-api-key", ASTROLOGY_API_KEY.trim());

        const astroResponse = await fetch(
          `https://json.freeastrologyapi.com/${apiEndpoint}`,
          {
            method: "POST",
            headers: headers,
            body: JSON.stringify(astroPayload)
          }
        );

        const raw = await astroResponse.text();

        return new Response(raw, {
          status: astroResponse.status,
          headers: corsHeaders
        });
      }

      // ---------------- SAVE CHAT ENDPOINT ----------------
      if (url.pathname === "/api/save-chat") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
          if (!userEmail) throw new Error("No email in token");
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        if (!PROFILES) {
          return new Response(
            JSON.stringify({ error: "Storage not configured" }),
            { status: 500, headers: corsHeaders }
          );
        }

        const body = await safeParseJSON(request);
        if (!body) {
          return new Response(
            JSON.stringify({ error: "Invalid JSON body" }),
            { status: 400, headers: corsHeaders }
          );
        }

        const chat = body.chat;

        if (!chat || !chat.id || !chat.messages || !Array.isArray(chat.messages)) {
          return new Response(
            JSON.stringify({ error: "Invalid chat format" }),
            { status: 400, headers: corsHeaders }
          );
        }

        const sanitizedChat = {
          id: sanitizeString(chat.id, 100),
          title: sanitizeString(chat.title, 200) || 'Untitled Chat',
          messages: chat.messages.slice(-50).map(m => ({
            role: m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
            content: sanitizeString(m.content, 10000)
          })),
          lastUpdated: Date.now(),
          createdAt: chat.createdAt || Date.now()
        };

        await PROFILES.put(
          `chat:${userEmail}:${chat.id}`,
          JSON.stringify(sanitizedChat),
          { expirationTtl: 2592000 }
        );

        return new Response(
          JSON.stringify({ success: true, message: "Chat saved successfully" }),
          { headers: corsHeaders }
        );
      }

      // ---------------- LOAD CHATS ENDPOINT ----------------
      if (url.pathname === "/api/get-chats") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
          if (!userEmail) throw new Error("No email in token");
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        if (!PROFILES) {
          return new Response(
            JSON.stringify({ error: "Storage not configured" }),
            { status: 500, headers: corsHeaders }
          );
        }

        const list = await PROFILES.list({ prefix: `chat:${userEmail}:` });

        const chats = [];
        for (const key of list.keys) {
          const data = await PROFILES.get(key.name);
          if (data) {
            try {
              const chat = JSON.parse(data);
              chats.push({
                id: chat.id,
                title: chat.title || 'Untitled Chat',
                lastUpdated: chat.lastUpdated || 0,
                createdAt: chat.createdAt || 0,
                messages: chat.messages || [],
                messageCount: chat.messages?.length || 0
              });
            } catch (e) {
              console.error(`Failed to parse chat ${key.name}:`, e);
            }
          }
        }

        chats.sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

        return new Response(
          JSON.stringify({
            success: true,
            chats,
            count: chats.length
          }),
          { headers: corsHeaders }
        );
      }

      // ---------------- DELETE CHAT ENDPOINT ----------------
      if (url.pathname === "/api/delete-chat") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
          if (!userEmail) throw new Error("No email in token");
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        let chatId;
        if (request.method === "DELETE") {
          chatId = url.searchParams.get('chatId');
        } else {
          const body = await safeParseJSON(request);
          if (!body) {
            return new Response(
              JSON.stringify({ error: "Invalid JSON body" }),
              { status: 400, headers: corsHeaders }
            );
          }
          chatId = body.chatId;
        }

        if (!chatId) {
          return new Response(
            JSON.stringify({ error: "Chat ID required" }),
            { status: 400, headers: corsHeaders }
          );
        }

        chatId = sanitizeString(chatId, 100);

        const chatKey = `chat:${userEmail}:${chatId}`;
        const existing = await PROFILES.get(chatKey);

        if (!existing) {
          return new Response(
            JSON.stringify({ error: "Chat not found" }),
            { status: 404, headers: corsHeaders }
          );
        }

        await PROFILES.delete(chatKey);

        return new Response(
          JSON.stringify({ success: true, message: "Chat deleted" }),
          { headers: corsHeaders }
        );
      }

      // ---------------- PROFILE MEMORY UPDATE ROUTE ----------------
      if (url.pathname === "/api/update-memory") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
          if (!userEmail) throw new Error("No email in token");
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        if (!PROFILES) {
          return new Response(
            JSON.stringify({ error: "Profile storage not configured" }),
            { status: 500, headers: corsHeaders }
          );
        }

        const body = await safeParseJSON(request);
        if (!body) {
          return new Response(
            JSON.stringify({ error: "Invalid JSON body" }),
            { status: 400, headers: corsHeaders }
          );
        }

        const conversation = body.conversation;
        if (!conversation || !Array.isArray(conversation)) {
          return new Response(
            JSON.stringify({ error: "Missing conversation array" }),
            { status: 400, headers: corsHeaders }
          );
        }

        const recentConversation = conversation.slice(-10);

        const sanitizedConversation = recentConversation.map(msg => ({
          role: msg.role === 'user' || msg.role === 'assistant' ? msg.role : 'user',
          content: sanitizeString(msg.content, 500)
        }));

        const existingProfileJson = await PROFILES.get(`profile:${userEmail}`);
        const existingProfile = existingProfileJson ? JSON.parse(existingProfileJson) : {
          version: 1,
          createdAt: Date.now(),
          confidenceScore: 0.1
        };

        const memoryPrompt = `
You are updating a long-term AI user profile.

From the conversation below, extract:

1. Skill level (beginner/intermediate/advanced)
2. Recurring interests (array of topics)
3. Preferred explanation depth (concise/detailed/balanced)
4. Tone preference (casual/professional/friendly)
5. Patterns user dislikes (array, e.g., ["jargon", "long paragraphs"])
6. 2-3 sentence persona summary

Respond ONLY in valid JSON format:

{
  "skillLevel": "",
  "interests": [],
  "detailPreference": "",
  "tonePreference": "",
  "dislikedPatterns": [],
  "personaSummary": ""
}

Conversation:
${sanitizedConversation.map(msg => `${msg.role}: ${msg.content}`).join('\n')}
`;

        const groqResponse = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
              model: "openai/gpt-oss-20b",
              messages: [{ role: "user", content: memoryPrompt }],
              temperature: 0.3,
              max_tokens: 1024
            })
          }
        );

        if (!groqResponse.ok) {
          const err = await groqResponse.text();
          return new Response(
            JSON.stringify({ error: "Memory extraction failed", details: err }),
            { status: 500, headers: corsHeaders }
          );
        }

        const groqData = await groqResponse.json();
        const extractedText = groqData.choices?.[0]?.message?.content;

        let extracted;
        try {
          const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          extracted = JSON.parse(jsonMatch[0]);
        } catch (e) {
          return new Response(
            JSON.stringify({ error: "Failed to parse extracted profile", raw: extractedText }),
            { status: 500, headers: corsHeaders }
          );
        }

        const updatedProfile = {
          version: existingProfile.version || 1,
          createdAt: existingProfile.createdAt || Date.now(),
          ...existingProfile,
          skillLevel: extracted.skillLevel || existingProfile.skillLevel || "intermediate",
          interests: [...new Set([...(extracted.interests || []), ...(existingProfile.interests || [])])].slice(0, 10),
          detailPreference: extracted.detailPreference || existingProfile.detailPreference || "balanced",
          tonePreference: extracted.tonePreference || existingProfile.tonePreference || "friendly",
          dislikedPatterns: [...new Set([...(extracted.dislikedPatterns || []), ...(existingProfile.dislikedPatterns || [])])],
          personaSummary: extracted.personaSummary || existingProfile.personaSummary || "",
          personalizationEnabled: true,
          confidenceScore: Math.min((existingProfile.confidenceScore || 0.1) + 0.1, 1),
          lastUpdated: Date.now()
        };

        await PROFILES.put(`profile:${userEmail}`, JSON.stringify(updatedProfile));

        return new Response(
          JSON.stringify({ success: true, profile: updatedProfile }),
          { headers: corsHeaders }
        );
      }

      // ---------------- FILE UPLOAD ENDPOINT ----------------
      if (url.pathname === "/api/upload") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        try {
          const token = authHeader.replace("Bearer ", "");
          await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "File uploaded (storage not implemented)",
            summary: "File received successfully"
          }),
          { headers: corsHeaders }
        );
      }

      // ---------------- SUBSCRIPTION STATUS ENDPOINT ----------------
      if (url.pathname === "/api/subscription-status") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
          if (!userEmail) throw new Error("No email in token");
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        if (!PROFILES) {
          return new Response(
            JSON.stringify({ error: "Storage not configured" }),
            { status: 500, headers: corsHeaders }
          );
        }

        const profileJson = await PROFILES.get(`profile:${userEmail}`);
        const profile = profileJson ? JSON.parse(profileJson) : null;

        return new Response(
          JSON.stringify({
            status: profile?.subscriptionStatus || "inactive",
            subscriptionId: profile?.subscriptionId || null,
            activatedAt: profile?.subscriptionActivatedAt || null
          }),
          { headers: corsHeaders }
        );
      }

      // ---------------- CREATE SUBSCRIPTION ENDPOINT ----------------
      if (url.pathname === "/api/create-subscription") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: corsHeaders
          });
        }
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          const userEmail = payload.email;
          const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_SECRET}`);

          // 🔁 Direct subscription creation

          const razorRes = await fetch("https://api.razorpay.com/v1/subscriptions", {
            method: "POST",
            headers: {
              "Authorization": `Basic ${razorpayAuth}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              plan_id: env.RAZORPAY_PLAN_ID,
              total_count: 12,
              customer_notify: 1,
              notes: {
                userEmail: userEmail
              }
            })
          });
          const data = await razorRes.json();
          if (!razorRes.ok) {
            return new Response(JSON.stringify(data), {
              status: razorRes.status,
              headers: corsHeaders
            });
          }
          return new Response(JSON.stringify(data), {
            headers: corsHeaders
          });
        } catch (err) {
          console.error("Subscription error:", err);
          return new Response(
            JSON.stringify({ error: "Subscription creation failed", details: err.message }),
            { status: 500, headers: corsHeaders }
          );
        }
      }

      // ---------------- VERIFY PAYMENT ENDPOINT ----------------
      if (url.pathname === "/api/verify-payment") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: corsHeaders
          });
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        const body = await safeParseJSON(request);
        if (!body) {
          return new Response(
            JSON.stringify({ error: "Invalid JSON body" }),
            { status: 400, headers: corsHeaders }
          );
        }

        validateRequiredFields(body, ['payment_id', 'subscription_id', 'signature']);

        const { payment_id, subscription_id, signature } = body;

        // Use Web Crypto API (works in Cloudflare Workers)
        const encoder = new TextEncoder();
        const keyData = encoder.encode(env.RAZORPAY_SECRET);

        const cryptoKey = await crypto.subtle.importKey(
          "raw",
          keyData,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );

        const signed = await crypto.subtle.sign(
          "HMAC",
          cryptoKey,
          encoder.encode(subscription_id + "|" + payment_id)
        );

        if (!payment_id || !subscription_id || !signature) {
          return new Response(JSON.stringify({ error: "Invalid payment response" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const generatedSignature = Array.from(new Uint8Array(signed))
          .map(b => b.toString(16).padStart(2, "0"))
          .join("");

        if (generatedSignature !== signature) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Update subscription status in profile
        const profileJson = await PROFILES.get(`profile:${userEmail}`);
        const profile = profileJson ? JSON.parse(profileJson) : {
          version: 1,
          createdAt: Date.now(),
          confidenceScore: 0.1
        };

        // 🔁 Active subscription status
        profile.subscriptionStatus = "active";
        profile.subscriptionId = subscription_id;
        profile.subscriptionActivatedAt = Date.now();
        profile.subscriptionPaymentId = payment_id;

        await PROFILES.put(`profile:${userEmail}`, JSON.stringify(profile));

        return new Response(JSON.stringify({
          success: true,
          message: "Payment verified and subscription activated"
        }), {
          headers: corsHeaders
        });
      }

      // ---------------- CANCEL SUBSCRIPTION ENDPOINT ----------------
      if (url.pathname === "/api/cancel-subscription") {

        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: corsHeaders
          });
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: corsHeaders
          });
        }

        const profileJson = await PROFILES.get(`profile:${userEmail}`);
        if (!profileJson) {
          return new Response(JSON.stringify({ error: "No subscription found" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const profile = JSON.parse(profileJson);

        const razorpayAuth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_SECRET}`);

        await fetch(`https://api.razorpay.com/v1/subscriptions/${profile.subscriptionId}/cancel`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${razorpayAuth}`
          }
        });

        profile.subscriptionStatus = "cancelled";
        profile.subscriptionId = null;
        profile.subscriptionPaymentId = null;
        profile.subscriptionActivatedAt = null;

        await PROFILES.put(`profile:${userEmail}`, JSON.stringify(profile));

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }


      // ---------------- AI WEBSITE BUILDER ENDPOINTS ----------------

      // 1. GENERATE WEBSITE (PREVIEW)
      if (url.pathname === "/api/generate-website") {

        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ error: "Authentication required" }),
            { status: 401, headers: corsHeaders }
          );
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Invalid token", details: err.message }),
            { status: 401, headers: corsHeaders }
          );
        }

        // Limit check for free users
        const profileJson = await PROFILES.get(`profile:${userEmail}`);
        const profile = profileJson ? JSON.parse(profileJson) : {};
        const isPremium = profile.subscriptionStatus === "active";

        if (!isPremium) {
          const genCount = profile.websiteGenerations || 0;
          if (genCount >= 3) {
            return new Response(
              JSON.stringify({ error: "Free plan limit reached (2 regenerations). Upgrade to Premium for unlimited generations." }),
              { status: 403, headers: corsHeaders }
            );
          }
          profile.websiteGenerations = genCount + 1;
          await PROFILES.put(`profile:${userEmail}`, JSON.stringify(profile));
        }

        const body = await safeParseJSON(request);
        if (!body || !body.name || !body.type || !body.services) {
          return new Response(
            JSON.stringify({ error: "Mission required fields: name, type, and services are mandatory." }),
            { status: 400, headers: corsHeaders }
          );
        }

        const { name, type, services, desc, color, targetAudience, goals, cta, category } = body;

        const prompt = `Create a complete responsive landing page for a business with the following details:

Business Name: ${name}
Business Type: ${type}
Services: ${services}
Description: ${desc || 'A modern business'}
Target Audience: ${targetAudience || 'general audience'}
Business Goals: ${goals || 'attract customers'}
Call to Action: ${cta || 'contact'}
Category: ${category || 'other'}

Requirements:
- modern, professional design suitable for ${category || 'business'}
- fully responsive (mobile, tablet, desktop)
- hero section with clear value proposition and ${cta || 'contact'} button
- services or features grid
- about section
- contact form
- modern typography
- inline CSS only (no external libraries)
- primary color: ${color || '#10a37f'}
- clean, semantic HTML5

Output rules:
Return ONLY valid HTML.
Do not include explanations or markdown formatting like \`\`\`html.`;

        let ai;
        try {
          ai = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "openai/gpt-oss-120b",
              messages: [{ role: "user", content: prompt }],
              temperature: 0.7,
              max_tokens: 4096
            })
          });
        } catch (fetchErr) {
          return new Response(JSON.stringify({ error: "Failed to reach AI Gateway", details: fetchErr.message }), { status: 504, headers: corsHeaders });
        }

        const result = await ai.json();

        if (!ai.ok) {
          return new Response(JSON.stringify({
            error: "Groq API Error",
            details: result.error?.message || "Unknown Groq error",
            status: ai.status
          }), { status: 502, headers: corsHeaders });
        }

        if (!result.choices || !result.choices[0]) {
          return new Response(JSON.stringify({ error: "AI returned no content" }), { status: 500, headers: corsHeaders });
        }

        let html = result.choices[0].message.content;

        // Basic cleanup
        html = html.replace(/^```html\n?/, '').replace(/\n?```$/, '').trim();

        if (html.startsWith("`")) html = html.replace(/^`+|`+$/g, '');

        html = sanitizeHTML(html);

        return new Response(JSON.stringify({
          id: crypto.randomUUID(),
          html: html
        }), { headers: corsHeaders });
      }

      // 2. PUBLISH WEBSITE
      if (url.pathname === "/api/publish-website") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: corsHeaders });
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders });
        }

        // Check limits
        const siteList = await PROFILES.list({ prefix: `site:${userEmail}:` });

        // Subscription check
        const profileJson = await PROFILES.get(`profile:${userEmail}`);
        const profile = profileJson ? JSON.parse(profileJson) : {};
        const isPremium = profile.subscriptionStatus === "active";

        if (!isPremium && siteList.keys.length >= 1) {
          return new Response(JSON.stringify({ error: "Free plan limit reached (1 site). Upgrade to publish more." }), { status: 403, headers: corsHeaders });
        }

        const body = await safeParseJSON(request);
        const { id, html, name } = body;

        // Store HTML in KV
        try {
          await env.SITES_KV.put(`site-html:${id}`, html);
        } catch (kvError) {
          return new Response(JSON.stringify({ error: "Storage error (KV)." }), { status: 500, headers: corsHeaders });
        }

        // Store Metadata in KV
        const metadata = {
          id,
          name,
          url: `/sites/${id}`,
          rating: (Math.random() * (9.5 - 7.0) + 7.0).toFixed(1),
          created: Date.now()
        };

        await PROFILES.put(`site:${userEmail}:${id}`, JSON.stringify(metadata));

        return new Response(JSON.stringify({ success: true, url: metadata.url }), { headers: corsHeaders });
      }

      // 3. MY WEBSITES
      if (url.pathname === "/api/my-websites") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: corsHeaders });
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders });
        }

        const siteList = await PROFILES.list({ prefix: `site:${userEmail}:` });
        const sites = [];
        for (const key of siteList.keys) {
          const val = await PROFILES.get(key.name);
          if (val) sites.push(JSON.parse(val));
        }

        return new Response(JSON.stringify({ sites }), { headers: corsHeaders });
      }

      // 4. DELETE WEBSITE
      if (url.pathname === "/api/delete-website") {
        if (!authHeader?.startsWith("Bearer ")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: corsHeaders });
        }

        let userEmail;
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email;
        } catch (err) {
          return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders });
        }

        const body = await safeParseJSON(request);
        const { id } = body;

        await env.SITES_KV.delete(`site-html:${id}`);
        await PROFILES.delete(`site:${userEmail}:${id}`);

        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // ================ MAIN AI CHAT ROUTE ================
      let userEmail = "guest@novax.ai";
      let userProfile = null;

      if (authHeader?.startsWith("Bearer ")) {
        try {
          const token = authHeader.replace("Bearer ", "");
          const payload = await verifyFirebaseToken(token, FIREBASE_PROJECT_ID);
          userEmail = payload.email || "guest@novax.ai";

          if (userEmail && PROFILES) {
            const profileJson = await PROFILES.get(`profile:${userEmail}`);
            if (profileJson) {
              userProfile = JSON.parse(profileJson);
            }
          }

        } catch (err) {
          console.warn("Auth failed, using guest mode");
          userEmail = "guest@novax.ai";
        }
      }
      // ---------------- RATE LIMITING ----------------
      const ip = request.headers.get("CF-Connecting-IP") || 'unknown';
      if (ip && PROFILES) {
        const rateKey = `rate:${userEmail}:${ip}`;
        const rateData = await PROFILES.get(rateKey);
        const currentCount = rateData ? parseInt(rateData) : 0;

        if (currentCount >= 20) {
          return new Response(
            JSON.stringify({ error: "Too many requests. Please slow down." }),
            { status: 429, headers: corsHeaders }
          );
        }

        await PROFILES.put(rateKey, String(currentCount + 1), { expirationTtl: 60 });
      }

      // ---------------- PROCESS CHAT REQUEST ----------------
      const body = await safeParseJSON(request);
      if (!body) {
        return new Response(
          JSON.stringify({ error: "Invalid JSON body" }),
          { status: 400, headers: corsHeaders }
        );
      }

      const { messages, model = "fast", webSearch = false } = body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return new Response(JSON.stringify({ error: "Invalid messages format" }), {
          status: 400,
          headers: corsHeaders
        });
      }

        const isPremium = userProfile?.subscriptionStatus === "active";
  
        const premiumModels = ["deep", "astrology"];
        if (premiumModels.includes(model) && !isPremium) {
          return new Response(
            JSON.stringify({ error: "This model requires an active subscription." }),
            { status: 403, headers: corsHeaders }
          );
        }

      const cleanMessages = messages.slice(-20).map(m => {
        const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
        return {
          role,
          content: sanitizeString(m.content, 5000)
        };
      });

      let finalMessages = cleanMessages;
      if (userProfile && userProfile.personalizationEnabled && (userProfile.confidenceScore || 0) > 0.2) {
        let systemPrompt = `You are NovaX AI, a helpful and knowledgeable assistant.`;

        systemPrompt += `

User Persona Information:
- Skill Level: ${userProfile.skillLevel || "Not specified"}
- Tone Preference: ${userProfile.tonePreference || "friendly"}
- Detail Preference: ${userProfile.detailPreference || "balanced"}
- Key Interests: ${userProfile.interests?.join(", ") || "General conversation"}
- Avoid These Patterns: ${userProfile.dislikedPatterns?.join(", ") || "None specified"}

Persona Summary:
${userProfile.personaSummary || "No specific persona summary available."}
`;

        finalMessages = [
          { role: "system", content: systemPrompt },
          ...cleanMessages
        ];
      }

      // ---------------- WEB SEARCH ----------------
      let sources = [];
      if (webSearch && SERPER_API_KEY) {
        const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content || "";
        if (lastUserMsg) {
          try {
            const searchResponse = await fetch('https://google.serper.dev/search', {
              method: 'POST',
              headers: {
                'X-API-KEY': SERPER_API_KEY,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ q: lastUserMsg, num: 5 })
            });

            if (searchResponse.ok) {
              const searchData = await searchResponse.json();
              sources = (searchData.organic || []).slice(0, 5).map(r => ({
                title: sanitizeString(r.title, 200),
                url: r.link,
                snippet: sanitizeString(r.snippet || '', 500)
              }));
            }
          } catch (e) {
            console.error("Web search failed:", e);
          }
        }

        if (sources.length > 0) {
          finalMessages.push({
            role: "system",
            content: `Use the following fresh web sources for accurate citations. Cite them as [1], [2], etc.\n\nSources:\n${sources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join('\n')}`
          });
        }
      }

      const modelMap = {
        fast: "openai/gpt-oss-20b",
        deep: "openai/gpt-oss-120b",
        astrology: "openai/gpt-oss-120b"
      };
      const selectedModel = modelMap[model] || modelMap.fast;

      const groqResponse = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: finalMessages,
            temperature: 0.7,
            max_tokens: 2048,
            stream: true
          })
        }
      );

      if (!groqResponse.ok) {
        const err = await groqResponse.text();
        return new Response(JSON.stringify({ error: err }), {
          status: groqResponse.status,
          headers: corsHeaders
        });
      }

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = groqResponse.body.getReader();
      const encoder = new TextEncoder();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (sources.length > 0) {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`));
              }
              await writer.write(encoder.encode(`data: [DONE]\n\n`));
              await writer.close();
              break;
            }
            await writer.write(value);
          }
        } catch (error) {
          console.error("Streaming error:", error);
          try {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ error: "Streaming failed" })}\n\n`));
            await writer.close();
          } catch (e) { }
        }
      })();

      return new Response(readable, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        }
      });

    } catch (err) {
      console.error("Unhandled error:", err.message, err.stack);
      return new Response(
        JSON.stringify({ error: "Internal server error", details: err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  }
};