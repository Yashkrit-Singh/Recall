import Link from 'next/link'
import { signIn, signUp } from './actions'

const inputClass = 'mt-2 w-full rounded-xl border border-[#e5e2de] bg-[#fff] px-4 py-3 text-sm outline-none transition placeholder:text-[#aaa8b0] focus:border-[#8979df] focus:ring-4 focus:ring-[#ece9fc]'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams
  return <main className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-8">
    <section className="w-full max-w-[440px] rounded-[26px] border border-[#e9e6e1] bg-white p-6 shadow-[0_20px_60px_rgba(37,32,62,.07)] sm:p-9">
      <Link href="/" className="inline-flex items-center gap-3" aria-label="Recall home"><span className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#29243e] text-lg font-semibold text-white">R</span><span className="text-lg font-semibold tracking-tight">Recall</span></Link>
      <p className="mt-9 text-xs font-semibold uppercase tracking-[.12em] text-[#7568bb]">Your personal video memory</p>
      <h1 className="mt-2 text-[30px] font-semibold tracking-[-.035em]">Welcome back.</h1>
      <p className="mt-2 text-sm leading-6 text-[#77747e]">Sign in to save videos worth remembering and find them again in Telegram.</p>
      {params.error && <p role="alert" className="mt-5 rounded-xl border border-[#efd4d1] bg-[#fff7f6] p-3 text-sm text-[#9b4e48]">{params.error}</p>}
      {params.message && <p role="status" className="mt-5 rounded-xl border border-[#d7eadc] bg-[#f3faf5] p-3 text-sm text-[#38694b]">{params.message}</p>}
      <form className="mt-7 space-y-4">
        <label className="block text-sm font-medium text-[#44414c]">Email<input required type="email" name="email" autoComplete="email" placeholder="you@example.com" className={inputClass} /></label>
        <label className="block text-sm font-medium text-[#44414c]">Password<input required minLength={6} type="password" name="password" autoComplete="current-password" placeholder="At least 6 characters" className={inputClass} /></label>
        <div className="grid gap-3 pt-2 sm:grid-cols-2"><button formAction={signIn} className="rounded-xl bg-[#29243e] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#403961]">Sign in</button><button formAction={signUp} className="rounded-xl border border-[#e5e2de] bg-white px-4 py-3 text-sm font-semibold text-[#4c4954] transition hover:bg-[#f8f7f5]">Create account</button></div>
      </form>
      <p className="mt-6 border-t border-[#f0eeeb] pt-5 text-xs leading-5 text-[#898692]">Your library is private to your account. Use the account you connected to Recall.</p>
    </section>
  </main>
}
