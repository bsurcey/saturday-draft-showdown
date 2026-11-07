# Saturday Draft Showdown

A static Netlify site with a Netlify Function that retrieves November 7, 2026 college football scores from ESPN's public scoreboard endpoint.

## Deploy

1. Unzip this project.
2. Push the **contents of the `draft-showdown` folder** to a GitHub repository.
3. In Netlify, choose **Add new project > Import an existing project**, connect the repository, leave build command blank, and deploy. Netlify detects `netlify.toml` and deploys the serverless function.
4. Share the generated Netlify URL. The page automatically polls every 60 seconds.

**Important:** Dragging only `index.html` to Netlify Drop will not deploy the serverless function. Use Git-based deployment or Netlify CLI (`netlify deploy --prod`) from the project folder.

## Editing rosters

The `rosters` JavaScript object in `index.html` lists every participant and team. To remove one of Dave's teams, delete its entry from Dave's array and redeploy.

## Caveats

This uses an unofficial, undocumented ESPN endpoint, which may change or be temporarily unavailable. The endpoint may omit some lower-division games. Missing games are displayed as `Bye / not found` and excluded from wins/losses. No projected wins or win probabilities are included. No persistent database is needed, since the rosters are fixed and everyone sees the same live score feed.
