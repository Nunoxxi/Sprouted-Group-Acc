-- Supabase schema for the Sprouted accounting app
-- Run this in Supabase SQL Editor.

create extension if not exists "pgcrypto";

create table if not exists companies (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    company_type text not null,
    code text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists users (
    id uuid primary key default gen_random_uuid(),
    username text not null unique,
    password_hash text not null,
    role text not null default 'viewer',
    company_id uuid references companies(id),
    created_at timestamptz not null default now()
);

create table if not exists transactions (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id),
    description text not null,
    amount numeric not null default 0,
    entry_type text not null default 'income',
    created_at timestamptz not null default now()
);

-- optional starter rows
insert into companies (name, company_type, code)
values
    ('Sprouted Roots', 'charity', 'SR'),
    ('Sprouted Assets', 'llc', 'SA'),
    ('Sprouted Services', 'llc', 'SS')
on conflict (code) do nothing;
