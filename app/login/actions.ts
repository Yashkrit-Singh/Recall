'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

type AuthOperation = 'sign in' | 'create account'

function explainAuthError(message: string, operation: AuthOperation) {
  const lower = message.toLowerCase()
  if (/fetch failed|failed to fetch|network|enotfound|timed out/.test(lower)) {
    return 'Recall could not reach Supabase. Check the project URL and your internet connection, then try again.'
  }
  if (/redirect url|redirect_to|not allowed/.test(lower)) {
    return 'Supabase rejected the sign-up redirect. Add http://localhost:3000/auth/callback in Authentication → URL Configuration.'
  }
  if (/email_address_invalid|invalid email/.test(lower)) {
    return 'Supabase rejected that email address. Use a real email address you can access; example or test addresses are not accepted.'
  }
  if (/email_address_not_authorized/.test(lower)) {
    return 'This Supabase project can only send test emails to project organization members. Use an authorized address or configure custom SMTP.'
  }
  if (/already registered|already exists/.test(lower)) {
    return 'That email already has an account. Sign in instead, or use another email.'
  }
  if (/rate limit|too many requests/.test(lower)) {
    return 'Supabase is limiting sign-up attempts. Wait a little and try again.'
  }
  if (/invalid api key|invalid.*key|apikey/.test(lower)) {
    return 'Supabase rejected the public key. Check that the URL and publishable key are from the same project.'
  }
  if (operation === 'sign in') return 'Could not sign in. Check your email and password, or create an account first.'
  return 'Could not create the account. Check the Supabase Auth settings and try again.'
}

function showError(message: string): never {
  redirect(`/login?error=${encodeURIComponent(message)}`)
}

export async function signIn(formData: FormData) {
  const supabase = await createClient()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    console.error('[Recall] Supabase sign-in failed:', error.status, error.code, error.message)
    showError(explainAuthError(error.message, 'sign in'))
  }
  redirect('/saved')
}

export async function signUp(formData: FormData) {
  const supabase = await createClient()
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'}/auth/callback` } })
  if (error) {
    console.error('[Recall] Supabase sign-up failed:', error.status, error.code, error.message)
    showError(explainAuthError(error.message, 'create account'))
  }
  if (data.session) redirect('/saved')
  redirect('/login?message=Check%20your%20email%20to%20confirm%20your%20account.')
}
