import Link from 'next/link'
import { signIn, signUp } from './actions'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams
  return (
    <main className="min-h-screen px-5 py-10 sm:px-8">
      <div className="mx-auto flex min-h-[80vh] max-w-5xl items-center justify-center">
        <section className="w-full max-w-md rounded-[28px] border border-[#e7e5de] bg-white p-7 shadow-sm sm:p-10">
          <Link href="/" className="text-sm font-semibold tracking-[.18em] text-[#526449]">RECALL</Link>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[.16em] text-[#7d8679]">Your second memory</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Welcome back.</h1>
          <p className="mt-2 text-sm leading-6 text-[#73776f]">Sign in or create an account to keep your saved things close.</p>
          {params.error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{params.error}</p>}
          {params.message && <p role="status" className="mt-5 rounded-xl bg-green-50 p-3 text-sm text-green-800">{params.message}</p>}
          <form className="mt-7 space-y-4">
            <label className="block text-sm font-medium">Email<input required type="email" name="email" autoComplete="email" className="mt-2 w-full rounded-xl border border-[#dedfd8] bg-[#fcfcfa] px-4 py-3 outline-none focus:border-[#617453]" /></label>
            <label className="block text-sm font-medium">Password<input required minLength={6} type="password" name="password" autoComplete="current-password" className="mt-2 w-full rounded-xl border border-[#dedfd8] bg-[#fcfcfa] px-4 py-3 outline-none focus:border-[#617453]" /></label>
            <div className="grid grid-cols-2 gap-3 pt-2">
              <button formAction={signIn} className="rounded-xl bg-[#263426] px-4 py-3 text-sm font-semibold text-white hover:bg-[#384b38]">Sign in</button>
              <button formAction={signUp} className="rounded-xl border border-[#dfe2d8] px-4 py-3 text-sm font-semibold hover:bg-[#f7f8f3]">Create account</button>
            </div>
          </form>
          <p className="mt-6 text-xs leading-5 text-[#858980]">Your library is private to your account. Use a password you can remember; password recovery can be added later.</p>
        </section>
      </div>
    </main>
  )
}
