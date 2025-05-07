
async function cancelOrder(orderId) {
  if (!confirm('注文をキャンセルしてもよろしいですか？')) {
    return;
  }

  try {
    const response = await fetch('/cancel-order', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orderId })
    });

    if (response.ok) {
      location.reload();
    } else {
      alert('キャンセルに失敗しました');
    }
  } catch (error) {
    console.error('Error:', error);
    alert('エラーが発生しました');
  }
}
