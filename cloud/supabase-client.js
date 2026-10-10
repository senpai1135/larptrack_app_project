import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let client = null;

if (window.supabase) {
    try {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {
        console.error('Supabase client could not be created — check cloud/config.js:', e.message);
    }
} else {
    console.error(
        'Supabase library not found on window. Check that the <script src=".../supabase-js@2"> ' +
        'tag in index.html loaded (requires an internet connection).'
    );
}

export const supabase = client;
