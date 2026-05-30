import pandas as pd
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# Read both files
file1 = r"C:\Users\rahul\Downloads\admissions-nic-in-2026-05-30.xlsx"
file2 = r"C:\Users\rahul\Downloads\admissions-nic-in-2026-05-30 (1).xlsx"

pd.set_option('display.max_columns', None)
pd.set_option('display.width', 400)
pd.set_option('display.max_colwidth', 60)
pd.set_option('display.max_rows', 20)

print("=" * 80)
print("FILE 1:", file1)
print("=" * 80)

xls1 = pd.ExcelFile(file1)
print(f"Sheets: {xls1.sheet_names}")
for sheet in xls1.sheet_names:
    df = pd.read_excel(file1, sheet_name=sheet)
    print(f"\n--- Sheet: '{sheet}' ---")
    print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns")
    # Safe column print
    cols = []
    for c in df.columns:
        try:
            cols.append(str(c))
        except:
            cols.append(repr(c))
    print(f"Columns: {cols}")
    print(f"\nDtypes:")
    for col in df.columns:
        print(f"  {str(col)}: {df[col].dtype}")
    print(f"\nFirst 15 rows:")
    print(df.head(15).to_string())
    print(f"\nLast 5 rows:")
    print(df.tail(5).to_string())
    
    # Numeric stats
    num_cols = df.select_dtypes(include='number').columns
    if len(num_cols) > 0:
        print(f"\nNumeric Stats:")
        print(df[num_cols].describe().to_string())
    
    print(f"\nNull counts:")
    for col in df.columns:
        nc = df[col].isnull().sum()
        if nc > 0:
            print(f"  {str(col)}: {nc} nulls")
    
    print(f"\nUnique value counts:")
    for col in df.columns:
        ucount = df[col].nunique()
        print(f"  {str(col)}: {ucount} unique")
        if ucount <= 30:
            vc = df[col].value_counts().head(30)
            for val, count in vc.items():
                print(f"    {val}: {count}")

print("\n\n" + "=" * 80)
print("FILE 2:", file2)
print("=" * 80)

xls2 = pd.ExcelFile(file2)
print(f"Sheets: {xls2.sheet_names}")
for sheet in xls2.sheet_names:
    df = pd.read_excel(file2, sheet_name=sheet)
    print(f"\n--- Sheet: '{sheet}' ---")
    print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns")
    cols = []
    for c in df.columns:
        try:
            cols.append(str(c))
        except:
            cols.append(repr(c))
    print(f"Columns: {cols}")
    print(f"\nDtypes:")
    for col in df.columns:
        print(f"  {str(col)}: {df[col].dtype}")
    print(f"\nFirst 15 rows:")
    print(df.head(15).to_string())
    print(f"\nLast 5 rows:")
    print(df.tail(5).to_string())
    
    num_cols = df.select_dtypes(include='number').columns
    if len(num_cols) > 0:
        print(f"\nNumeric Stats:")
        print(df[num_cols].describe().to_string())
    
    print(f"\nNull counts:")
    for col in df.columns:
        nc = df[col].isnull().sum()
        if nc > 0:
            print(f"  {str(col)}: {nc} nulls")
    
    print(f"\nUnique value counts:")
    for col in df.columns:
        ucount = df[col].nunique()
        print(f"  {str(col)}: {ucount} unique")
        if ucount <= 30:
            vc = df[col].value_counts().head(30)
            for val, count in vc.items():
                print(f"    {val}: {count}")
