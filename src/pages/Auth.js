// src/pages/Auth.js
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';

function Auth() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate(); 

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
       
        navigate('/room/12345'); 
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        alert('Sign-up successful! Check your email if confirmation is required.');
        setIsLogin(true);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
      <h2>{isLogin ? 'Login' : 'Sign Up'}</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        /><br /><br />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        /><br /><br />
        <button type="submit" disabled={loading}>
          {loading ? 'Please wait...' : isLogin ? 'Login' : 'Sign Up'}
        </button>
      </form>
      <br />
      <button onClick={() => setIsLogin(!isLogin)} disabled={loading}>
        {isLogin ? "Don't have an account? Sign Up" : 'Have an account? Log In'}
      </button>
    </div>
  );
}

export default Auth;


// // src/pages/Auth.js
// import React, { useState, useEffect } from 'react';
// import { useNavigate, useSearchParams } from 'react-router-dom';
// import { supabase } from '../supabaseClient';

// function Auth() {
//   const [email, setEmail] = useState('');
//   const [password, setPassword] = useState('');
//   const [isLogin, setIsLogin] = useState(true);
//   const [loading, setLoading] = useState(false);
//   const [emailVerified, setEmailVerified] = useState(false);
//   const [searchParams] = useSearchParams();
//   const navigate = useNavigate();

//   useEffect(() => {
//     // Check for email verification redirect
//     const checkEmailVerification = async () => {
//       const type = searchParams.get('type');
//       if (type === 'signup') {
//         setEmailVerified(true);
//       }
//     };

//     checkEmailVerification();
//   }, [searchParams]);

//   const handleSubmit = async (e) => {
//     e.preventDefault();
//     setLoading(true);

//     try {
//       if (isLogin) {
//         const { error } = await supabase.auth.signInWithPassword({ email, password });
//         if (error) throw error;
//         navigate('/room/12345');
//       } else {
//         const { error } = await supabase.auth.signUp({ 
//           email, 
//           password,
//           options: {
//             emailRedirectTo: `${window.location.origin}/auth?type=signup`
//           }
//         });
//         if (error) throw error;
//         alert('Sign-up successful! Please check your email for verification.');
//         setIsLogin(true);
//       }
//     } catch (err) {
//       alert(err.message);
//     } finally {
//       setLoading(false);
//     }
//   };

//   if (emailVerified) {
//     return (
//       <div style={{ padding: '2rem', textAlign: 'center' }}>
//         <h2>Email Verified Successfully!</h2>
//         <p>Your email address has been verified. You can now log in to your account.</p>
//         <button 
//           onClick={() => {
//             setEmailVerified(false);
//             navigate('/auth');
//           }}
//           style={{ marginTop: '1rem' }}
//         >
//           Back to Login
//         </button>
//       </div>
//     );
//   }

//   return (
//     <div style={{ padding: '2rem' }}>
//       <h2>{isLogin ? 'Login' : 'Sign Up'}</h2>
//       <form onSubmit={handleSubmit}>
//         <input
//           type="email"
//           placeholder="Email"
//           value={email}
//           onChange={(e) => setEmail(e.target.value)}
//           required
//         /><br /><br />
//         <input
//           type="password"
//           placeholder="Password"
//           value={password}
//           onChange={(e) => setPassword(e.target.value)}
//           required
//         /><br /><br />
//         <button type="submit" disabled={loading}>
//           {loading ? 'Please wait...' : isLogin ? 'Login' : 'Sign Up'}
//         </button>
//       </form>
//       <br />
//       <button onClick={() => setIsLogin(!isLogin)} disabled={loading}>
//         {isLogin ? "Don't have an account? Sign Up" : 'Have an account? Log In'}
//       </button>
//     </div>
//   );
// }

// export default Auth;