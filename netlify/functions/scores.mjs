export default async (request) => {
  const url = new URL(request.url);
  const date = /^\d{8}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : '20261107';
  const endpoint = `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates=${date}&limit=500&groups=80`;
  try {
    const response = await fetch(endpoint, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`Score provider returned ${response.status}`);
    const data = await response.json();
    return new Response(JSON.stringify({ events: data.events || [], fetchedAt: new Date().toISOString(), source: 'ESPN' }), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
};
