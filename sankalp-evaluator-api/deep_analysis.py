import pandas as pd
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

file1 = r"C:\Users\rahul\Downloads\admissions-nic-in-2026-05-30.xlsx"
file2 = r"C:\Users\rahul\Downloads\admissions-nic-in-2026-05-30 (1).xlsx"

df1 = pd.read_excel(file1)
df2 = pd.read_excel(file2)

# Rename columns for easier use
col_map = {}
for c in df1.columns:
    clean = str(c).replace('_▲▼','').replace('_Γû▓Γû╝','').strip()
    col_map[c] = clean

df1 = df1.rename(columns=col_map)
df2 = df2.rename(columns=col_map)

print("="*80)
print("COMPARISON: Are both files identical?")
print("="*80)

# Drop scraper columns for comparison
compare_cols = ['srno','institute','program','category','opening_rank','closing_rank','round','stream','seat_type','quota']
c1 = [c for c in compare_cols if c in df1.columns]

match_cols = [c for c in c1 if c in df2.columns]
if len(match_cols) > 0:
    merged = df1[match_cols].reset_index(drop=True)
    merged2 = df2[match_cols].reset_index(drop=True)
    if merged.equals(merged2):
        print(">>> BOTH FILES CONTAIN IDENTICAL DATA (same 3020 rows, same values)")
    else:
        diffs = (merged != merged2).sum()
        print("Differences per column:")
        print(diffs[diffs > 0])

print("\n" + "="*80)
print("DEEP ANALYSIS: WBJEE 2025 Opening & Closing Rank Cutoffs")
print("="*80)

df = df1.copy()  # Use file1 since they're the same

# Clean column names
for c in df.columns:
    cname = str(c)
    if 'institute' in cname.lower():
        df.rename(columns={c: 'institute'}, inplace=True)
    elif 'program' in cname.lower():
        df.rename(columns={c: 'program'}, inplace=True)
    elif 'category' in cname.lower():
        df.rename(columns={c: 'category'}, inplace=True)
    elif 'opening_rank' in cname.lower():
        df.rename(columns={c: 'opening_rank'}, inplace=True)
    elif 'closing_rank' in cname.lower():
        df.rename(columns={c: 'closing_rank'}, inplace=True)
    elif 'round' in cname.lower():
        df.rename(columns={c: 'round'}, inplace=True)
    elif 'stream' in cname.lower():
        df.rename(columns={c: 'stream'}, inplace=True)
    elif 'seat_type' in cname.lower():
        df.rename(columns={c: 'seat_type'}, inplace=True)
    elif 'quota' in cname.lower():
        df.rename(columns={c: 'quota'}, inplace=True)

print(f"\nTotal records: {len(df)}")
print(f"Institutes: {df['institute'].nunique()}")
print(f"Programs: {df['program'].nunique()}")
print(f"Categories: {df['category'].nunique()}")

# === TOP INSTITUTES by lowest opening rank (Open category, Round 1, WBJEE Seats) ===
print("\n" + "-"*80)
print("TOP 20 INSTITUTES - Lowest Opening Rank (Open Category, Round 1, WBJEE Seats)")
print("-"*80)
filt = df[(df['category']=='Open') & (df['round']=='Round 1') & (df['seat_type'].str.contains('WBJEE', na=False))]
top = filt.sort_values('opening_rank').head(20)[['institute','program','opening_rank','closing_rank','quota']]
for i, row in top.iterrows():
    print(f"  Rank {row['opening_rank']:>7} - {row['closing_rank']:>7} | {row['institute'][:55]:<55} | {row['program'][:45]}")

# === TOP CSE Cutoffs ===
print("\n" + "-"*80)
print("TOP 25 CSE CUTOFFS - Open Category, WBJEE Seats, Round 1")
print("-"*80)
cse = filt[filt['program'].str.contains('Computer Science', case=False, na=False)]
cse_sorted = cse.sort_values('opening_rank').head(25)
for i, row in cse_sorted.iterrows():
    print(f"  OR: {row['opening_rank']:>7} CR: {row['closing_rank']:>7} | {row['institute'][:55]:<55} | {row['program'][:50]}")

# === Category-wise analysis ===
print("\n" + "-"*80)
print("CATEGORY-WISE AVERAGE CLOSING RANK (All Rounds)")
print("-"*80)
cat_stats = df.groupby('category').agg(
    count=('closing_rank','count'),
    avg_opening=('opening_rank','mean'),
    avg_closing=('closing_rank','mean'),
    min_opening=('opening_rank','min'),
    max_closing=('closing_rank','max')
).sort_values('avg_closing')
for cat, row in cat_stats.iterrows():
    print(f"  {cat:<22} | Count: {int(row['count']):>5} | Avg Open: {int(row['avg_opening']):>7} | Avg Close: {int(row['avg_closing']):>7} | Best: {int(row['min_opening']):>6} | Worst: {int(row['max_closing']):>8}")

# === Round 1 vs Round 2 comparison ===
print("\n" + "-"*80)
print("ROUND 1 vs ROUND 2 COMPARISON")
print("-"*80)
round_stats = df.groupby('round').agg(
    count=('closing_rank','count'),
    avg_opening=('opening_rank','mean'),
    avg_closing=('closing_rank','mean'),
).round(0)
for r, row in round_stats.iterrows():
    print(f"  {r}: {int(row['count'])} entries, Avg Opening: {int(row['avg_opening'])}, Avg Closing: {int(row['avg_closing'])}")

# === Seat type distribution ===
print("\n" + "-"*80)
print("SEAT TYPE & QUOTA DISTRIBUTION")
print("-"*80)
print("  Seat Types:")
for val, cnt in df['seat_type'].value_counts().items():
    print(f"    {val}: {cnt}")
print("  Quotas:")
for val, cnt in df['quota'].value_counts().items():
    print(f"    {val}: {cnt}")

# === Stream distribution ===
print("\n" + "-"*80)
print("STREAM DISTRIBUTION")
print("-"*80)
for val, cnt in df['stream'].value_counts().items():
    print(f"  {val}: {cnt}")

# === List all 119 institutes ===
print("\n" + "-"*80)
print("ALL 119 INSTITUTES (with entry count)")
print("-"*80)
inst_counts = df['institute'].value_counts().sort_index()
for i, (inst, cnt) in enumerate(inst_counts.items(), 1):
    print(f"  {i:>3}. {inst[:70]:<70} ({cnt} entries)")

# === List all 123 programs ===
print("\n" + "-"*80)
print("ALL 123 PROGRAMS (with entry count)")
print("-"*80)
prog_counts = df['program'].value_counts().sort_values(ascending=False)
for i, (prog, cnt) in enumerate(prog_counts.items(), 1):
    print(f"  {i:>3}. {prog[:70]:<70} ({cnt} entries)")

# === Top colleges for specific popular programs ===
for prog_name in ['Computer Science & Engineering', 'Electronics & Communication Engineering', 
                   'Electrical Engineering', 'Mechanical Engineering', 'Information Technology']:
    print(f"\n" + "-"*80)
    print(f"TOP 10 COLLEGES FOR '{prog_name}' (Open, Round 1, WBJEE)")
    print("-"*80)
    pf = df[(df['program']==prog_name) & (df['category']=='Open') & (df['round']=='Round 1') & (df['seat_type'].str.contains('WBJEE'))]
    pf_sorted = pf.sort_values('opening_rank').head(10)
    for _, row in pf_sorted.iterrows():
        print(f"  OR: {row['opening_rank']:>7} CR: {row['closing_rank']:>7} | {row['institute'][:60]}")
