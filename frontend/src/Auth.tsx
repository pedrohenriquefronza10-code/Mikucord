import { useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Heart, ShieldCheck, Sparkles } from 'lucide-react';
import { post } from './api';
import { useStore } from './store';
import { Mark, ErrorText, Spinner } from './ui';
import type { User } from './types';
export function Auth() {
  const [register, setRegister] = useState(false),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const setUser = useStore((s) => s.setUser);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await post<{ user: User }>(
        `/auth/${register ? 'register' : 'login'}`,
        register ? { username: name, password } : { handle: name, password },
      );
      setUser(result.user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-art">
        <a className="wordmark" href="/">
          <Mark />
          <span>
            tetocord<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="auth-story">
          <span className="eyebrow">
            <span className="tiny-dot" /> FEITO PARA ESTAR PERTO
          </span>
          <h1>
            Seu cantinho
            <br />
            na <span>internet.</span>
          </h1>
          <p>
            As conversas de sempre.
            <br />
            As pessoas que fazem a diferença.
          </p>
          <div className="orbit-art" aria-hidden="true">
            <div className="orbit one" />
            <div className="orbit two" />
            <div className="orbit-center">
              <Mark size={75} />
            </div>
            <div className="orbit-card card-one">
              <span className="emoji-avatar">🍓</span>
              <span>
                partiu jogar?<small>o grupo já tá aqui ✨</small>
              </span>
              <i />
            </div>
            <div className="orbit-card card-two">
              <span className="emoji-avatar mint">🌱</span>
              <span>
                cheguei!<small>só mais uma partida</small>
              </span>
            </div>
            <span className="art-star star-one">✦</span>
            <span className="art-star star-two">✧</span>
            <span className="art-doodle">☺</span>
          </div>
        </div>
        <div className="auth-foot">
          <Heart size={14} />
          <span>Um lugar só nosso. Sem complicação.</span>
        </div>
      </div>
      <main className="auth-form-wrap">
        <div className="auth-form">
          <span className="pill">
            <Sparkles size={13} /> BEM-VINDO AO TETOCORD
          </span>
          <h2>
            {register ? 'Tudo começa com um oi.' : 'Bom te ver por aqui.'}
            <span> ✨</span>
          </h2>
          <p>
            {register
              ? 'Crie sua conta e encontre a sua turma.'
              : 'Entre, puxe uma cadeira e fique à vontade.'}
          </p>
          <form onSubmit={submit}>
            <label>
              {register ? 'Como podemos te chamar?' : 'Usuário e tag'}
              <input
                name="username"
                autoComplete="username"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={register ? 'Seu nome de usuário' : 'seunome#1234'}
                maxLength={register ? 32 : 40}
              />
            </label>
            <label>
              Senha
              <div className="password-input">
                <input
                  name="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={register ? 10 : 1}
                  type={visible ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={register ? 'Pelo menos 10 caracteres' : 'Aquela que só você sabe'}
                />
                <button
                  type="button"
                  aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            <ErrorText error={error} />
            <button className="primary auth-submit" disabled={busy}>
              {busy ? <Spinner /> : register ? 'Criar minha conta' : 'Entrar no meu cantinho'}
              {!busy && <ArrowRight size={18} />}
            </button>
          </form>
          <p className="auth-switch">
            {register ? 'Já faz parte da turma?' : 'Ainda não tem uma conta?'}{' '}
            <button
              onClick={() => {
                setRegister(!register);
                setError('');
              }}
            >
              {register ? 'Entrar' : 'Pode chegar'}
            </button>
          </p>
          <div className="auth-private">
            <ShieldCheck size={17} />
            <span>Seu espaço privado, com seus amigos.</span>
          </div>
        </div>
        <footer>
          TETOCORD <span>•</span> CONEXÕES DE VERDADE
        </footer>
      </main>
    </div>
  );
}
