/* static/config.js - public site configuration.
   Everything here is public by design: the publishable key only grants what
   the database's row-level security allows. Never put a secret key here. */
window.UMG_CONFIG = {
    // Server-run game (answers checked by the server). false = the classic
    // in-browser game, which is what the live site uses until launch.
    // For testing, add ?server=1 (or ?server=0) to the play page URL.
    serverGame: false,

    supabaseUrl: 'https://notsgakxgnkgcrlvnduw.supabase.co',
    supabaseKey: 'sb_publishable_A9huMQ7O27LZTi-GiXtFzg_-fVqO1H7',

    // Cloudflare Turnstile SITE key (public). The SECRET key goes only in
    // Supabase: Authentication > Bot and Abuse Protection. Empty = no bot check.
    turnstileSiteKey: '0x4AAAAAAFWURn9KzuU00-d9'
};
