// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://raycsvgjhnaounaxdlbl.supabase.co'; 
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJheWNzdmdqaG5hb3VuYXhkbGJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3OTczMjgsImV4cCI6MjA2NTM3MzMyOH0.PwiBfVLZNcWR6emQr7qBs9SPFcWRuuXzrBU5WgrLxx8';               // Replace with your actual anon key

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
