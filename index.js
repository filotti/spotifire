require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const SpotifyWebApi = require('spotify-web-api-node');

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;
const freshness_days = process.env.FRESHNESS_DAYS || 365;
const min_popularity = process.env.MIN_POPULARITY || 60;
const stateKey = 'spotify_auth_state';

const spotifyApi = new SpotifyWebApi();
const app = express();

app.use(express.static(__dirname + '/public'))
  .use(cors())
  .use(cookieParser())
  .use(express.urlencoded({extended: true}));

app.get('/login', function (req, res) {
  const state = generateRandomString(16);
  res.cookie(stateKey, state);
  const scope = 'user-read-private user-read-email playlist-read-private playlist-modify-private';
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('client_id', client_id);
  url.searchParams.append('scope', scope);
  url.searchParams.append('redirect_uri', redirect_uri);
  url.searchParams.append('state', state);
  res.redirect(url.href);
});

app.get('/callback', async (req, res) => {

  const code = req.query.code || null;
  const state = req.query.state || null;
  const storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    console.log("state is null or not equal to stored state");
    res.status(401).send('Invalid state');
  } else {
    res.clearCookie(stateKey);
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('redirect_uri', redirect_uri);
    params.append('grant_type', 'authorization_code');
    const authOptions = {
      body: params,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + (Buffer.from(client_id + ':' + client_secret).toString('base64'))
      }
    };

    const response = await fetch('https://accounts.spotify.com/api/token', authOptions);
    const body = await response.json();
    const access_token = body.access_token;
    const refresh_token = body.refresh_token;
    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);
    res.redirect('/playlists');
  }
});

app.get('/playlists', async (req, res) => {
  try {
    const playlists = await spotifyApi.getUserPlaylists();
    let response = '<form action="/generate" method="post">';
    for (item in playlists.body.items) {
      response += `
                <p>
                    <input type="checkbox" name="${playlists.body.items[item].id}">
                    ${playlists.body.items[item].name} - ${playlists.body.items[item].description}
                </p>
            `;
    }
    response += '<input type="submit" value="Generate Playlist"></form>';

    res.send(response);
  } catch (error) {
    res.redirect('/login');
  }

});

app.post('/generate', async (req, res) => {
  try {
    let tracks = [];

    // Fetch all playlists concurrently
    const allPlaylists = await Promise.all(
      Object.keys(req.body).map(
        id => spotifyApi.getPlaylistTracks(id)
      )
    );

    for (const playlist of allPlaylists) {
      playlist.body.items.forEach(item => {
        if (item.track && !tracks[item.track.id])
          tracks[item.track.id] = item.track;
      });
    }

    tracks = Object.values(tracks).sort((a, b) => b.popularity - a.popularity);

    console.log("Initial number of tracks: " + tracks.length);

    // filter out tracks that are below the min_popularity
    tracks = tracks.filter(track => track.popularity >= min_popularity);

    console.log("Tracks after filtering for popularity: " + tracks.length);

    // Filter out tracks that are older than the freshness_days
    tracks = tracks.filter(track => {
      const date = new Date();
      date.setDate(date.getDate() - freshness_days);
      return new Date(track.album.release_date) > date;
    });

    console.log("Tracks after filtering for release date: " + tracks.length);

    const response = await spotifyApi.createPlaylist(`Generated Playlist ${new Date().toISOString()}`, {'public': false});
    const playlistId = response.body.id;

    const chunkedTrackUris = chunkArray(tracks.map(track => track.uri), 100);

    // Add all tracks to the playlist concurrently
    await Promise.all(chunkedTrackUris.map(async (chunk, i) => {
      console.log(`Adding tracks ${i * 100} - ${(i + 1) * 100}`);
      await spotifyApi.addTracksToPlaylist(playlistId, chunk);
    }));

    res.send("Playlist generated!");
  } catch (error) {
    console.log(error);
    res.redirect('/login');
  }
});

console.log('Listening on 8080');
app.listen(8080);

const generateRandomString = length => {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

const chunkArray = (array, size) => {
  let chunked_arr = [];
  for (let i = 0; i < array.length; i += size) {
    chunked_arr.push(array.slice(i, i + size));
  }
  return chunked_arr;
}
