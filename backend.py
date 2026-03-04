from scripts import all
from supabase import create_client, Client
from supabase_auth import Provider  
supabase = create_client("YOUR_SUPABASE_URL", "YOUR_SUPABASE_ANON_OR_SERVICE_KEY")
supabase.auth.sign_in_with_oauth({  
    Provider:'google'
})




