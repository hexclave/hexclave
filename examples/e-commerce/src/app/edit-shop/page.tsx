import "server-only";

import Link from 'next/link';
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { hexclaveServerApp } from '@/hexclave';
import { Product, Shop } from "@/shop";

export default async function EditShop() {
  const user = await hexclaveServerApp.getUser({ or: "throw" });
  const shop: Shop | undefined = user.serverMetadata?.eCommerceExample?.shop ?? undefined;

  async function createShop(formData: FormData) {
    "use server";
    await (await hexclaveServerApp.listUsers()).find(u => u.id === user.id)!.setServerMetadata({
      // TODO this should be more like a transaction
      ...user.serverMetadata,
      eCommerceExample: {
        shop: {
          displayName: "My Shop",
          products: [
            {
              id: randomUUID(),
              name: "Product",
              dollarPrice: 10,
            }
          ],
        },
      },
    });
    revalidatePath("/edit-shop");
    revalidatePath("/");
  }

  async function deleteShop(formData: FormData) {
    "use server";
    await (await hexclaveServerApp.listUsers()).find(u => u.id === user.id)!.setServerMetadata({
      // TODO this should be more like a transaction
      ...user.serverMetadata,
      eCommerceExample: {
        shop: undefined,
      },
    });
    revalidatePath("/edit-shop");
    revalidatePath("/");
  }

  async function saveShop(formData: FormData) {
    "use server";
    const oldShop = shop;
    if (!oldShop) {
      throw new Error("Can't save shop that doesn't exist");
    }
    const products: Product[] = [];
    for (let i = 0; i < oldShop.products.length; i++) {
      products.push({
        ...oldShop.products[i],
        name: formData.get(`product${i}Name`) as string,
        dollarPrice: Number(formData.get(`product${i}DollarPrice`)),
      });
    }
    await (await hexclaveServerApp.listUsers()).find(u => u.id === user.id)!.setServerMetadata({
      // TODO this should be more like a transaction
      ...user.serverMetadata,
      eCommerceExample: {
        shop: {
          displayName: formData.get("displayName") as string,
          products,
        },
      },
    });
    revalidatePath("/edit-shop");
    revalidatePath("/");
  }

  return (
    <>
      <Link href="/">Back to home</Link>
      <div className="card">
        <h2>Edit Shop</h2>
        {shop ? (
          <>
            {/* eslint-disable-next-line @typescript-eslint/no-misused-promises */}
            <form action={saveShop}>
              Shop Name:{" "}<input name="displayName" type="text" defaultValue={shop.displayName} />
              <ul>
                {shop.products.map((product, i) => (
                  <li key={product.id}>
                    <input name={`product${i}Name`} type="text" defaultValue={product.name} />{" for "}$<input name={`product${i}DollarPrice`} type="number" defaultValue={product.dollarPrice} />
                  </li>
                ))}
              </ul>
              <button type="submit">Save Shop</button>
            </form>
            {/* eslint-disable-next-line @typescript-eslint/no-misused-promises */}
            <form action={deleteShop}>
              <button type="submit">Delete Shop</button>
            </form>
          </>
        ) : (
          <>
            You don&apos;t have a shop yet.
            {/* eslint-disable-next-line @typescript-eslint/no-misused-promises */}
            <form action={createShop}>
              <button type="submit">Create Shop</button>
            </form>
          </>
        )}
      </div>
    </>
  );
}
