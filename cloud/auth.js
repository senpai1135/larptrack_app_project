import { supabase } from './supabase-client.js';

const UNAVAILABLE = 'Cloud services are unavailable right now (Supabase failed to load). ' +
    'Check your internet connection and try again.';

function requireClient() {
    if (!supabase) throw new Error(UNAVAILABLE);
    return supabase;
}

export async function signUp(email, password) {
    const client = requireClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw error;
    return data;
}

export async function signIn(email, password) {
    const client = requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

export async function signOut() {
    const client = requireClient();
    const { error } = await client.auth.signOut();
    if (error) throw error;
}

export async function getCurrentUser() {
    if (!supabase) return null;
    const { data: { user } } = await supabase.auth.getUser();
    return user;
}

export async function getProfile(userId) {
    const client = requireClient();
    const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
    if (error) throw error;
    return data;
}

export function onAuthStateChange(callback) {
    if (!supabase) return { data: { subscription: { unsubscribe() {} } } };
    return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}
