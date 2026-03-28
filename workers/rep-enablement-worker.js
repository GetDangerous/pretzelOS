/**
 * Dangerous Pretzel Co — Rep Enablement Kit Generator
 * Cloudflare Worker (HTTP endpoint)
 *
 * Generates a tailored one-pager for distribution reps (US Foods, PFG Denver)
 * so THEIR reps can pitch Dangerous Pretzel cold — without Drew in the room.
 *
 * GET /rep-kit?distributor=us_foods   → US Foods version
 * GET /rep-kit?distributor=pfg_denver → PFG Denver version
 * GET /rep-kit/stats                  → What reps are clicking/using
 */

const BRAND_CONTEXT = `
Dangerous Pretzel Co — Salt Lake City's premium soft pretzel brand.
Tagline: "RUIN DINNER." / "Invented by monks, perfected for punks."
Website: dangerouspretzel.com

Current accounts (social proof for reps to name-drop):
- Delta Center (NBA Jazz arena — mammoth pretzel program)
- SLC Bees minor league baseball stadium  
- Powder Mountain Ski Resort
- Alta Ski (Goldminer's Daughter)
- The Union Event Center (major SLC event venue)
- Pioneer Theater Company
- TF Brewery, Hopkins Brewery, ROHA Brewing, HK Brewing

Product: Hand-crafted soft pretzels, unique flavors:
- Spicy Bee (chili-cheddar dough, hot honey glaze, candied jalapeños)
- BBK (parmesan, garlic, fresh herbs) 
- Saint (sweet cinnamon sugar)
- Salty (classic)
- For The Kids (fruity pebbles glaze)
- Salty Bombs (single-serve)

Program: Free loaner warmer placed at venue. They order pretzels wholesale. 
- Zero kitchen required
- Zero training required  
- Near-zero waste (frozen, reheat on demand)
- Lead time: 1-2 weeks SLC, via distributor for others
- Retail price: $7-8 per pretzel
- Monthly venue revenue: $1,000–$10,000+ depending on traffic
- Close rate: extremely high once venues see/taste the product

Covered by City Weekly, Salt Lake Magazine, Salt Lake Tribune, Axios.
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const distributor = url.searchParams.get('distributor') || 'general';

    if (path === '/rep-kit') {
      return generateRepKit(distributor, env);
    }

    if (path === '/rep-kit/html') {
      return generateRepKitHTML(distributor, env);
    }

    if (path === '/rep-kit/stats') {
      return getRepKitStats(env);
    }

    return new Response('Rep Enablement Worker', { status: 200 });
  }
};

async function generateRepKit(distributor, env) {
  const distributorContext = getDistributorContext(distributor);

  const prompt = `Generate a rep enablement one-pager for a ${distributorContext.name} account manager to pitch Dangerous Pretzel Co to their venue accounts.

Brand context:
${BRAND_CONTEXT}

Distributor context:
${distributorContext.context}

The rep is calling on: ${distributorContext.target_accounts}

Generate a complete one-pager with these sections:
1. "The 30-second pitch" — what to say on a cold call or in a customer visit. One paragraph, sounds human, not scripted.
2. "The numbers that close it" — 3 specific revenue stats the venue owner will respond to. Make them concrete.
3. "Your best accounts to call first" — 5 specific venue types ranked by fit, with a one-line reason for each.
4. "Common objections + how to handle them" — 4 objections with sharp responses. Don't be defensive — flip them.
5. "How to place the order" — exact steps from "customer says yes" to warmer placed. Make it dead simple.
6. "Your contact at Dangerous Pretzel" — Drew's contact info + that he'll do joint sales calls.

Rules:
- Write for a rep who knows food service but doesn't know Dangerous Pretzel
- Lead with money and social proof — Delta Center and Powder Mountain are the opening line
- Tone: professional but has the brand edge — "RUIN DINNER" energy, not corporate food-speak
- Every claim should be specific (revenue numbers, venue names, not vague statements)

Return JSON: {pitch_30sec, numbers, best_accounts, objections, how_to_place, contact_info, distributor_note}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) return new Response('Error generating kit', { status: 500 });

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/```json\n?|\n?```/g, '').trim();

  try {
    const kit = JSON.parse(clean);
    return new Response(JSON.stringify({ distributor, ...kit }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
  }
}

async function generateRepKitHTML(distributor, env) {
  const kitResponse = await generateRepKit(distributor, env);
  const kit = await kitResponse.json();
  const dist = getDistributorContext(distributor);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dangerous Pretzel Co — ${dist.name} Rep Kit</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff; max-width: 800px; margin: 0 auto; padding: 40px 24px; }
  .header { border-bottom: 3px solid #1a1a1a; padding-bottom: 20px; margin-bottom: 32px; display: flex; justify-content: space-between; align-items: flex-end; }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .tagline { font-size: 13px; color: #666; }
  .dist-badge { background: #1a1a1a; color: #fff; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 4px; letter-spacing: .05em; text-transform: uppercase; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #888; margin-bottom: 10px; }
  .pitch-box { background: #f5f5f5; border-left: 4px solid #1a1a1a; padding: 16px 18px; font-size: 15px; line-height: 1.6; border-radius: 0 6px 6px 0; }
  .numbers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .num-card { background: #1a1a1a; color: #fff; padding: 14px; border-radius: 6px; }
  .num-big { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .num-label { font-size: 12px; opacity: 0.7; }
  .accounts-list { display: flex; flex-direction: column; gap: 8px; }
  .account-item { display: flex; gap: 12px; align-items: flex-start; }
  .account-rank { width: 24px; height: 24px; background: #1a1a1a; color: #fff; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .account-name { font-weight: 600; font-size: 14px; }
  .account-why { font-size: 13px; color: #555; }
  .objections { display: flex; flex-direction: column; gap: 10px; }
  .objection { border: 1px solid #e5e5e5; border-radius: 6px; overflow: hidden; }
  .obj-q { background: #f9f9f9; padding: 10px 14px; font-size: 13px; font-style: italic; color: #555; border-bottom: 1px solid #e5e5e5; }
  .obj-a { padding: 10px 14px; font-size: 13px; font-weight: 500; }
  .steps { counter-reset: steps; display: flex; flex-direction: column; gap: 8px; }
  .step { counter-increment: steps; display: flex; gap: 12px; align-items: flex-start; font-size: 14px; }
  .step::before { content: counter(steps); width: 22px; height: 22px; background: #1a1a1a; color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }
  .contact-box { background: #f5f5f5; padding: 16px; border-radius: 6px; font-size: 14px; line-height: 1.7; }
  .contact-box strong { display: block; font-size: 16px; margin-bottom: 4px; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #aaa; text-align: center; }
  .proof-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .chip { font-size: 11px; padding: 3px 10px; background: #f0f0f0; border-radius: 20px; font-weight: 500; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo">DANGEROUS PRETZEL CO.</div>
    <div class="tagline">dangerouspretzel.com · (801) 916-0275</div>
  </div>
  <div class="dist-badge">${dist.name} Rep Kit</div>
</div>

<div class="section">
  <div class="section-title">Already trusted by</div>
  <div class="proof-chips">
    <span class="chip">Delta Center (NBA Jazz)</span>
    <span class="chip">SLC Bees Stadium</span>
    <span class="chip">Powder Mountain Ski Resort</span>
    <span class="chip">Alta Ski</span>
    <span class="chip">The Union Event Center</span>
    <span class="chip">Pioneer Theater</span>
    <span class="chip">TF Brewery</span>
    <span class="chip">Hopkins Brewery</span>
  </div>
</div>

<div class="section">
  <div class="section-title">Your 30-second pitch</div>
  <div class="pitch-box">${kit.pitch_30sec || ''}</div>
</div>

<div class="section">
  <div class="section-title">Numbers that close it</div>
  <div class="numbers">
    ${(kit.numbers || []).map(n => `
      <div class="num-card">
        <div class="num-big">${n.value || n.split(':')[0] || ''}</div>
        <div class="num-label">${n.label || n.split(':').slice(1).join(':') || n}</div>
      </div>
    `).join('')}
  </div>
</div>

<div class="section">
  <div class="section-title">Best accounts to call first</div>
  <div class="accounts-list">
    ${(kit.best_accounts || []).map((a, i) => `
      <div class="account-item">
        <div class="account-rank">${i + 1}</div>
        <div>
          <div class="account-name">${a.type || a.name || a}</div>
          <div class="account-why">${a.reason || a.why || ''}</div>
        </div>
      </div>
    `).join('')}
  </div>
</div>

<div class="section">
  <div class="section-title">Common objections</div>
  <div class="objections">
    ${(kit.objections || []).map(o => `
      <div class="objection">
        <div class="obj-q">"${o.objection || o.q || o}"</div>
        <div class="obj-a">${o.response || o.a || ''}</div>
      </div>
    `).join('')}
  </div>
</div>

<div class="section">
  <div class="section-title">How to place the order</div>
  <div class="steps">
    ${(kit.how_to_place || []).map(step => `
      <div class="step">${step}</div>
    `).join('')}
  </div>
</div>

<div class="section">
  <div class="section-title">Your contact at Dangerous Pretzel</div>
  <div class="contact-box">
    <strong>Drew — Founder, Dangerous Pretzel Co</strong>
    ${kit.contact_info || 'drew@dangerouspretzel.com · (801) 916-0275 · Will do joint sales calls in SLC metro and Denver.'}
  </div>
</div>

<div class="footer">
  Dangerous Pretzel Co · 352 W 600 S, Salt Lake City, UT · dangerouspretzel.com<br>
  As seen in: City Weekly · Salt Lake Magazine · Salt Lake Tribune · Axios
</div>

</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

function getDistributorContext(distributor) {
  const contexts = {
    us_foods: {
      name: 'US Foods',
      context: 'US Foods rep calling on their existing SLC and Utah accounts. They have broad coverage across restaurants, hotels, event venues, and institutions.',
      target_accounts: 'Hotels, event venues, institutional food service, restaurants that could add a pretzel program',
    },
    pfg_denver: {
      name: 'PFG Denver',
      context: 'Performance Food Group Denver rep. Drew has a personal relationship with John Ash and Chad Roberts. PFG Denver just onboarded Dangerous Pretzel. Focus on Colorado venues and the broader Rocky Mountain region.',
      target_accounts: 'Colorado breweries, ski resorts, event venues, stadiums, hotel bars — similar profile to SLC wins',
    },
    general: {
      name: 'Distribution Partner',
      context: 'General distribution partner pitching to venue accounts.',
      target_accounts: 'Breweries, event venues, ski resorts, stadiums, hotel bars, theaters',
    },
  };
  return contexts[distributor] || contexts.general;
}

async function getRepKitStats(env) {
  // Placeholder — wire up analytics later
  return new Response(JSON.stringify({
    message: 'Rep kit analytics coming soon — track via Cloudflare Analytics on the /rep-kit/html endpoint',
    endpoints: {
      us_foods_kit: '/rep-kit/html?distributor=us_foods',
      pfg_denver_kit: '/rep-kit/html?distributor=pfg_denver',
      json_output: '/rep-kit?distributor=us_foods',
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}
